/**
 * masterySummary.ts
 *
 * Core mastery computation, factored out of the student-facing route so it
 * can be called for an EXPLICIT identifier — the student route always used
 * to call it for the caller's own session id (req.auth.id), which is right
 * for a student looking at their own revision panel but wrong for a teacher
 * looking up one of their students: there was no way to ask "what does THIS
 * student's mastery look like" for anyone but yourself.
 *
 * Behaviour is unchanged from the original: quiz-based and free-text
 * evidence merged by the conservative minimum rule (Section~sec:mastery of
 * the report), recency-weighted, refined across the prerequisite graph.
 */
import { User } from "../../models/User";
import { fetchMastery, type MasteryInteraction } from "./masteryClient";
import { Recommender } from "../recommendation/skill-recommender";
import { loadRecommendationGraph } from "../../routes/web/shared";

type StoredAttempt = { subAcquisId?: string; moduleId?: string; correct?: boolean; submittedAt?: Date | string };
type StoredTextSignal = { subAcquisId?: string; moduleId?: string; score?: number; submittedAt?: Date | string };

export type MasteryRevisionEntry = {
  id: string;
  moduleId: string | null;
  title: string;
  masteryPct: number;
  status: string;
  unlocks: number;
  blockedBy: Array<{ id: string; title: string }>;
};

export type MasterySummary = {
  graphApplied: boolean;
  attempts: number;
  revise: MasteryRevisionEntry[];
  /** Average of every sous-acquis the student has direct evidence for (quiz
   * or free-text), 0-100. Null when there is no evidence at all yet. Not
   * part of the original student-facing payload — added for the teacher
   * overview, where a single summary number is needed alongside the detail. */
  overallMasteryPct: number | null;
};

export async function computeStudentMasterySummary(identifier: string): Promise<MasterySummary | null> {
  const [user, graph] = await Promise.all([
    User.findOne({ identifier })
      .select({ "progress.skillAttempts": 1, "progress.completedLessonKeys": 1, "progress.textSignals": 1 })
      .lean(),
    loadRecommendationGraph()
  ]);
  if (!graph) return null;

  const progress = (user as { progress?: {
    skillAttempts?: StoredAttempt[];
    completedLessonKeys?: string[];
    textSignals?: StoredTextSignal[];
  } } | null)?.progress;

  const attempts = [...(progress?.skillAttempts ?? [])]
    .filter((a) => a?.subAcquisId && graph[a.subAcquisId])
    .sort((a, b) => new Date(a.submittedAt ?? 0).getTime() - new Date(b.submittedAt ?? 0).getTime());
  const history: MasteryInteraction[] = attempts.map((a) => ({
    skillId: String(a.subAcquisId),
    correct: Boolean(a.correct)
  }));

  const targetSkillIds = Object.keys(graph);
  const mastery = await fetchMastery({ history, targetSkillIds, applyGraph: true });

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

  const recommender = new Recommender(graph);
  const completedSubIds = (progress?.completedLessonKeys ?? [])
    .map((key) => String(key).split("::")[1])
    .filter((id) => id && graph[id]);
  recommender.setCompleted(completedSubIds);

  // Direct evidence from TWO sources: quiz attempts and the NLP explain-check.
  // When both exist the WEAKER one wins — passing the MCQ doesn't cancel a
  // failed explanation, and vice versa (the conservative-minimum rule).
  const scoreBySub = new Map<string, number>();
  for (const [subSkillId, entry] of Object.entries(mastery.mastery)) {
    if (entry.source === "history") {
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

  const blockedById = new Map(
    (mastery.revisionOrder ?? []).map((r) => [r.skillId, r.blockedBy])
  );
  const revise: MasteryRevisionEntry[] = recommender.revisit({ limit: 6 }).map((entry) => ({
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

  const evidencedScores = [...scoreBySub.values()];
  const overallMasteryPct = evidencedScores.length
    ? Math.round(evidencedScores.reduce((sum, v) => sum + v, 0) / evidencedScores.length)
    : null;

  return {
    graphApplied: mastery.graphApplied,
    attempts: history.length,
    revise,
    overallMasteryPct
  };
}
