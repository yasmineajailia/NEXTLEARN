/**
 * learnerProfile.ts
 *
 * Builds a compact, privacy-safe "who is this student" profile from data the app
 * already persists (name, level/XP, VARK dominant style, recently-weak
 * sous-acquis, current lesson). The chatbot route passes it to the Python RAG
 * service, which uses it to adapt HOW it answers — tone, format, and which gaps
 * to reinforce — without changing the strict use-only-the-context grounding.
 *
 * Nothing here is sensitive: it is the student's own derived learning data
 * (curriculum labels + scores), never raw responses or biometric signals.
 */
import type { ModuleOverview } from "../../types/curriculum";

export type VarkStyle = "visual" | "readwrite" | "auditory" | "kinesthetic";

export type LearnerProfile = {
  name?: string;
  level?: number;
  vark?: VarkStyle | null;
  weakAreas?: string[];
  currentLesson?: string | null;
};

/** Minimal shape read from the User document (lean()). */
type UserLike = {
  fullName?: string;
  varkProfile?: { dominant?: string } | null;
  progress?: {
    xp?: number;
    skillAttempts?: Array<{
      subAcquisId?: string;
      score?: number;
      submittedAt?: Date | string;
    }>;
    textSignals?: Array<{
      subAcquisId?: string;
      score?: number;
      submittedAt?: Date | string;
    }>;
  } | null;
};

const PASS_SCORE = 60; // mirrors QUIZ_PASS_SCORE — below this, a sous-acquis is "weak"
const MAX_WEAK_AREAS = 3;

function firstName(fullName?: string): string | undefined {
  if (!fullName) return undefined;
  const first = String(fullName).trim().split(/\s+/)[0];
  return first || undefined;
}

function toVark(dominant?: string): VarkStyle | null {
  return dominant === "visual" || dominant === "readwrite" || dominant === "auditory" || dominant === "kinesthetic"
    ? dominant
    : null;
}

/**
 * The student's weakest recently-attempted sous-acquis, from BOTH evidence
 * sources: quiz attempts (latest score per sous-acquis) and text signals from
 * the "explain in your own words" analysis (latest concept-coverage score per
 * sous-acquis). When both exist for a sous-acquis the weaker one wins — a
 * student can pass the MCQ yet fail to explain the concept, and that gap is
 * exactly what the chatbot should reinforce. Named, ordered weakest-first,
 * capped so the prompt stays short.
 *
 * Keyed by `moduleId::subAcquisId`, not the bare sub-acquis id — the
 * curriculum has multiple modules (programmation-c, algorithmiques, ...) and
 * sub-acquis numbering ("1.1", "1.2", ...) restarts in each one, so a bare id
 * can collide across modules. `nameById` (built the same way) uses the same
 * composite key.
 */
function deriveWeakAreas(user: UserLike, nameById: Map<string, string>): string[] {
  // Latest score per sous-acquis, per evidence source.
  const latestOf = (
    entries: Array<{ moduleId?: string; subAcquisId?: string; score?: number; submittedAt?: Date | string }>
  ): Map<string, number> => {
    const latest = new Map<string, { at: number; score: number }>();
    for (const entry of entries) {
      const subId = String(entry?.subAcquisId || "");
      if (!subId) continue;
      const key = `${String(entry?.moduleId || "")}::${subId}`;
      const at = entry?.submittedAt ? new Date(entry.submittedAt).getTime() : 0;
      const score = typeof entry?.score === "number" ? entry.score : 0;
      const prev = latest.get(key);
      if (!prev || at >= prev.at) latest.set(key, { at, score });
    }
    return new Map([...latest.entries()].map(([key, e]) => [key, e.score]));
  };
  const quizScores = latestOf(user?.progress?.skillAttempts ?? []);
  const textScores = latestOf(user?.progress?.textSignals ?? []);

  // Merge: the weaker of the two latest signals defines the sous-acquis.
  const latestByKey = new Map<string, { score: number }>();
  for (const [key, score] of quizScores) latestByKey.set(key, { score });
  for (const [key, score] of textScores) {
    const prev = latestByKey.get(key);
    latestByKey.set(key, { score: prev ? Math.min(prev.score, score) : score });
  }
  return [...latestByKey.entries()]
    .filter(([, entry]) => entry.score < PASS_SCORE)
    .sort((a, b) => a[1].score - b[1].score)
    .slice(0, MAX_WEAK_AREAS)
    .map(([key]) => nameById.get(key) || key.split("::")[1] || key);
}

/**
 * Assembles the learner profile. `overview` is the full curriculum overview
 * (for mapping sous-acquis ids to human names); `filterToModuleId` +
 * `filterToSubAcquisId` identify the lesson the student is currently viewing,
 * if any.
 */
export function buildLearnerProfile(
  user: UserLike | null,
  overview: ModuleOverview[],
  filterToSubAcquisId?: string,
  filterToModuleId?: string
): LearnerProfile | undefined {
  if (!user) return undefined;

  // Keyed by moduleId::subAcquisId, not the bare id — see deriveWeakAreas.
  const nameById = new Map<string, string>();
  for (const moduleEntry of overview) {
    for (const sub of moduleEntry.subAcquis) nameById.set(`${moduleEntry.id}::${sub.id}`, sub.name);
  }

  const xp = user.progress?.xp ?? 0;
  return {
    name: firstName(user.fullName),
    level: Math.floor(xp / 1000) + 1, // matches public/student/sidebar-loader.js
    vark: toVark(user.varkProfile?.dominant),
    weakAreas: deriveWeakAreas(user, nameById),
    currentLesson:
      filterToModuleId && filterToSubAcquisId
        ? nameById.get(`${filterToModuleId}::${filterToSubAcquisId}`) || null
        : null
  };
}
