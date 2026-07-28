/**
 * Student mastery + revision route.
 *
 * Ties the KT model to the recommender: it builds the student's attempt SEQUENCE
 * from progress.skillAttempts, asks the Python SAKT + graph model for per-skill
 * mastery, then feeds that continuous mastery INTO the existing `Recommender`
 * (as sous-acquis scores) so revision recommendations are driven by dynamic
 * mastery instead of a binary pass/fail on the last quiz.
 *
 * Only skills the student has actually engaged (or that the graph could infer
 * from neighbours) drive the revision list — untouched skills stay out of it.
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { User } from "../../models/User";
import { fetchMastery, type MasteryInteraction } from "../../services/mastery/masteryClient";
import { Recommender } from "../../services/recommendation/skill-recommender";
import { loadRecommendationGraph } from "../web/shared";

export const masteryRouter = Router();

type StoredAttempt = { subAcquisId?: string; moduleId?: string; correct?: boolean; submittedAt?: Date | string };
type StoredTextSignal = { subAcquisId?: string; moduleId?: string; score?: number; submittedAt?: Date | string };

masteryRouter.get("/api/student/mastery", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? "";
    if (!identifier) return res.status(400).json({ message: "Identifiant requis" });

    const [user, graph] = await Promise.all([
      User.findOne({ identifier })
        .select({ "progress.skillAttempts": 1, "progress.completedLessonKeys": 1, "progress.textSignals": 1 })
        .lean(),
      loadRecommendationGraph()
    ]);
    if (!graph) return res.status(500).json({ message: "Graphe des compétences indisponible" });

    const progress = (user as { progress?: {
      skillAttempts?: StoredAttempt[];
      completedLessonKeys?: string[];
      textSignals?: StoredTextSignal[];
    } } | null)?.progress;

    // Ordered interaction sequence: oldest -> newest, one entry per attempt.
    const attempts = [...(progress?.skillAttempts ?? [])]
      .filter((a) => a?.subAcquisId && graph[a.subAcquisId])
      .sort((a, b) => new Date(a.submittedAt ?? 0).getTime() - new Date(b.submittedAt ?? 0).getTime());
    const history: MasteryInteraction[] = attempts.map((a) => ({
      skillId: String(a.subAcquisId),
      correct: Boolean(a.correct)
    }));

    const targetSkillIds = Object.keys(graph);
    const mastery = await fetchMastery({ history, targetSkillIds, applyGraph: true });

    // sous-acquis id -> module id, so the panel can deep-link the lesson page
    // (the skill graph only knows sous-acquis ids, not which module owns them).
    const subToModule = new Map<string, string>();
    for (const a of progress?.skillAttempts ?? []) {
      if (a?.subAcquisId && a?.moduleId) subToModule.set(String(a.subAcquisId), String(a.moduleId));
    }
    for (const key of progress?.completedLessonKeys ?? []) {
      const [moduleId, subId] = String(key).split("::");
      if (subId && moduleId) subToModule.set(subId, moduleId);
    }
    for (const signal of progress?.textSignals ?? []) {
      if (signal?.subAcquisId && signal?.moduleId) subToModule.set(String(signal.subAcquisId), String(signal.moduleId));
    }

    // NLP evidence: latest "explain in your own words" concept-coverage score
    // per sous-acquis (0-100). This is DIRECT evidence of understanding — a
    // student who passes the MCQ but cannot explain the concept should still
    // see it in the revision list.
    const latestTextScore = new Map<string, { at: number; score: number }>();
    for (const signal of progress?.textSignals ?? []) {
      const subId = String(signal?.subAcquisId || "");
      if (!subId || !graph[subId]) continue;
      const at = signal?.submittedAt ? new Date(signal.submittedAt).getTime() : 0;
      const prev = latestTextScore.get(subId);
      if (!prev || at >= prev.at) {
        latestTextScore.set(subId, { at, score: typeof signal?.score === "number" ? signal.score : 0 });
      }
    }

    // Feed KT mastery into the recommender. Only skills with real evidence
    // (direct attempts, or graph-inferred from evidenced neighbours) count —
    // a never-touched skill sitting at the 0.5 prior is not "to revise".
    const recommender = new Recommender(graph);
    const completedSubIds = (progress?.completedLessonKeys ?? [])
      .map((key) => String(key).split("::")[1])
      .filter((id) => id && graph[id]);
    recommender.setCompleted(completedSubIds);
    // Only skills the student has DIRECTLY practised drive the revision list —
    // you can't "revise" a skill you never attempted. Graph-inferred ("graph")
    // and untouched ("prior") skills still shaped the mastery values above (e.g.
    // a weak prerequisite gated a dependent down), they just aren't listed here.
    // Direct evidence comes from TWO sources: quiz attempts (KT mastery) and
    // the NLP explain-check (concept coverage). When both exist the weaker one
    // wins — passing the MCQ doesn't cancel a failed explanation, and vice versa.
    const scoreBySub = new Map<string, number>();
    for (const [subSkillId, entry] of Object.entries(mastery.mastery)) {
      if (entry.source === "sakt" || entry.source === "history") {
        scoreBySub.set(subSkillId, Math.round(entry.mastery * 100));
      }
    }
    for (const [subSkillId, entry] of latestTextScore) {
      const kt = scoreBySub.get(subSkillId);
      scoreBySub.set(subSkillId, kt === undefined ? entry.score : Math.min(kt, entry.score));
    }
    recommender.loadSubSkillScores(
      [...scoreBySub.entries()].map(([subSkillId, score]) => ({ subSkillId, score }))
    );

    // Weakest-first review list, enriched with the graph's "blocked by a weak
    // prerequisite" hints so the panel can tell the student what to fix first.
    const blockedById = new Map(
      (mastery.revisionOrder ?? []).map((r) => [r.skillId, r.blockedBy])
    );
    const revise = recommender.revisit({ limit: 6 }).map((entry) => ({
      id: entry.id,
      moduleId: subToModule.get(entry.id) ?? null,
      title: entry.title,
      masteryPct: entry.score,
      status: entry.status,
      unlocks: entry.unlocks.length,
      blockedBy: (blockedById.get(entry.id) ?? []).map((pid) => ({
        id: pid,
        title: graph[pid]?.title ?? pid
      }))
    }));

    return res.status(200).json({
      ktAvailable: mastery.available,
      testAuc: mastery.testAuc,
      graphApplied: mastery.graphApplied,
      attempts: history.length,
      revise
    });
  } catch (error) {
    console.error("Failed to build student mastery:", error);
    return res.status(500).json({ message: "Impossible de calculer la maîtrise pour le moment" });
  }
});
