/**
 * features.ts
 *
 * Single source of truth for the student risk-prediction feature vector.
 * Shared by the API (web.ts), the ML service, and the training scripts so the
 * feature definitions can never drift between training and inference.
 *
 * The model predicts the probability that a student catches up before exams.
 * Higher `catchup` probability = lower risk.
 */

/** Ordered feature keys — the vector order MUST match the training CSV columns. */
export const PREDICTION_FEATURE_KEYS = [
  "delayWeeks",
  "averageScore",
  "loginFrequency",
  "gapDepth",
  "recencyRatio",
  "weakSkillRatio",
  // Attention signal. `avgFocusScore` is only meaningful when `hasAttentionData`
  // is 1: attention tracking is consent-gated, so most students have none. The
  // indicator lets the forest learn to ignore the score when it is absent,
  // instead of us imputing a fake "neutral" focus for students who never opted
  // in — absence of data must never read as evidence of good (or bad) focus.
  "avgFocusScore",
  "hasAttentionData"
] as const;

export type PredictionFeatureKey = (typeof PREDICTION_FEATURE_KEYS)[number];

export type PredictionFeatures = Record<PredictionFeatureKey, number>;

/** Valid [min, max] range per feature — used for clamping and training jitter. */
export const PREDICTION_FEATURE_RANGES: Record<PredictionFeatureKey, [number, number]> = {
  delayWeeks: [0, 12],
  averageScore: [0, 100],
  loginFrequency: [0, 14],
  gapDepth: [0, 1],
  recencyRatio: [0, 1],
  weakSkillRatio: [0, 1],
  avgFocusScore: [0, 100],
  hasAttentionData: [0, 1]
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const RECENCY_WINDOW_DAYS = 28;
const WEAK_SCORE_THRESHOLD = 60;
const EXPECTED_PACE_PER_WEEK = 2;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Raw inputs needed to derive the 7 features for one student. */
export type PredictionFeatureInput = {
  /** Number of completed sous-acquis. */
  completedCount: number;
  /** Total sous-acquis in the curriculum (denominator for gapDepth). */
  totalSubAcquis: number;
  /** All quiz scores on 0–100 (ideally the latest per quiz). */
  quizScores: number[];
  /** Submission timestamps (ms) of quiz results, used for recency. */
  quizTimestamps: number[];
  loginCount: number;
  createdAt: number;
  lastLoginAt: number | null;
  /** Class schedule anchor (ms). When present, delay is measured against the course timeline. */
  scheduleStartAt: number | null;
  /**
   * Per-session average focus scores (0-100) from attention tracking. Optional:
   * empty/absent means the student never consented or never tracked a session,
   * which is recorded as hasAttentionData = 0 rather than imputed.
   */
  focusScores?: number[];
  now: number;
};

/**
 * Computes the 7-dimensional risk feature vector from a student's raw data.
 * Pure and NaN/divide-by-zero safe. Every output is clamped to its range.
 *
 * @param input - the student's raw progress/activity data.
 * @returns the clamped {@link PredictionFeatures} vector.
 */
export function computePredictionFeatures(input: PredictionFeatureInput): PredictionFeatures {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const completedCount = Math.max(0, Number(input.completedCount) || 0);
  const totalSubAcquis = Math.max(1, Number(input.totalSubAcquis) || 1);
  const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : now;

  const weeksSinceCreation = Math.max(1, (now - createdAt) / MS_PER_WEEK);

  const validScores = (Array.isArray(input.quizScores) ? input.quizScores : [])
    .map((s) => Number(s))
    .filter((s) => Number.isFinite(s) && s > 0);
  const averageScore =
    validScores.length > 0 ? validScores.reduce((a, b) => a + b, 0) / validScores.length : 50;

  const loginFrequency = clamp((Number(input.loginCount) || 0) / weeksSinceCreation, 0, 14);

  const gapDepth = clamp(1 - completedCount / totalSubAcquis, 0, 1);

  // Delay is measured against the class schedule when available, otherwise
  // against account age — "how many weeks behind the expected pace".
  const anchor =
    Number.isFinite(input.scheduleStartAt as number) && input.scheduleStartAt
      ? (input.scheduleStartAt as number)
      : createdAt;
  const weeksSinceAnchor = Math.max(0, (now - anchor) / MS_PER_WEEK);
  const expectedCompleted = weeksSinceAnchor * EXPECTED_PACE_PER_WEEK;
  const delayWeeks = clamp((expectedCompleted - completedCount) / EXPECTED_PACE_PER_WEEK, 0, 12);

  // Recency: 1.0 = active today, 0 = dormant RECENCY_WINDOW_DAYS+ days.
  const timestamps = (Array.isArray(input.quizTimestamps) ? input.quizTimestamps : []).filter((t) =>
    Number.isFinite(t)
  );
  const lastQuizAt = timestamps.length ? Math.max(...timestamps) : 0;
  const lastLoginAt = Number.isFinite(input.lastLoginAt as number) ? (input.lastLoginAt as number) || 0 : 0;
  const lastActivity = Math.max(lastQuizAt, lastLoginAt);
  const recencyRatio =
    lastActivity > 0 ? clamp(1 - (now - lastActivity) / MS_PER_DAY / RECENCY_WINDOW_DAYS, 0, 1) : 0;

  const weakSkillRatio =
    validScores.length > 0
      ? clamp(validScores.filter((s) => s < WEAK_SCORE_THRESHOLD).length / validScores.length, 0, 1)
      : 0;

  // Attention: reported only when it actually exists. When the student has no
  // tracked session, the score is left at 0 AND the indicator is 0 — the pair is
  // what the model reads, so a missing signal cannot masquerade as a real one.
  const focusScores = (Array.isArray(input.focusScores) ? input.focusScores : [])
    .map((s) => Number(s))
    .filter((s) => Number.isFinite(s) && s >= 0 && s <= 100);
  const hasAttentionData = focusScores.length > 0 ? 1 : 0;
  const avgFocusScore = hasAttentionData
    ? clamp(focusScores.reduce((a, b) => a + b, 0) / focusScores.length, 0, 100)
    : 0;

  return {
    delayWeeks,
    averageScore,
    loginFrequency,
    gapDepth,
    recencyRatio,
    weakSkillRatio,
    avgFocusScore,
    hasAttentionData
  };
}

/** Converts a feature record into the ordered numeric vector the model expects. */
export function predictionFeaturesToVector(features: PredictionFeatures): number[] {
  return PREDICTION_FEATURE_KEYS.map((key) => {
    const [min, max] = PREDICTION_FEATURE_RANGES[key];
    return clamp(Number(features[key]), min, max);
  });
}

export type RiskFactor = {
  /** Human-readable French label for the dashboard. */
  label: string;
  /** "high" = strong risk driver, "medium" = moderate, "good" = a protective factor. */
  level: "high" | "medium" | "good";
  /**
   * Signed SHAP contribution to the catch-up probability, in probability points
   * (e.g. -0.18 = this feature lowers the student's catch-up chance by 18pts).
   * Present only for model-derived (SHAP) explanations.
   */
  impact?: number;
  /** The underlying feature this factor explains (SHAP explanations only). */
  feature?: PredictionFeatureKey;
};

/**
 * Derive the ML prediction feature vector from a user's raw progress data and
 * profile. Thin adapter over the shared {@link computePredictionFeatures}.
 */
export function extractMLFeatures(params: {
  progress?: {
    completedLessonKeys?: unknown[];
    quizResults?: Array<{ score?: unknown; submittedAt?: unknown }>;
    selfEvaluationResults?: Array<{ score?: unknown }>;
    attentionSessions?: Array<{ avgFocusScore?: unknown; moduleId?: unknown }>;
  };
  profile?: {
    loginCount?: number;
    lastLoginDate?: Date | null;
    createdAt?: Date;
  } | null;
  totalSubAcquis?: number;
  /** Class schedule anchor — when present, delay is measured against the course timeline. */
  scheduleStartDate?: Date | string | null;
  /** When set, features are scoped to a single module (lessons + quizzes of that module only). */
  moduleId?: string;
}): PredictionFeatures {
  const { progress, profile, totalSubAcquis = 42, scheduleStartDate = null, moduleId } = params;

  const allCompletedKeys = Array.isArray(progress?.completedLessonKeys) ? progress.completedLessonKeys : [];
  const completedKeys = moduleId
    ? allCompletedKeys.filter((k) => typeof k === "string" && (k as string).startsWith(`${moduleId}::`))
    : allCompletedKeys;
  const completedCount = completedKeys.length;

  const allQuizResults = Array.isArray(progress?.quizResults) ? progress.quizResults : [];
  const quizResults = moduleId
    ? allQuizResults.filter((r) => String((r as any)?.moduleId || "") === moduleId)
    : allQuizResults;
  const quizScores = quizResults.map((r) => Number(r?.score));
  const quizTimestamps = quizResults
    .map((r) => {
      const d = r?.submittedAt ? new Date(r.submittedAt as any) : null;
      return d && !Number.isNaN(d.getTime()) ? d.getTime() : NaN;
    })
    .filter((t) => Number.isFinite(t));

  // Attention sessions, scoped to the module when the prediction is. A student
  // with sessions elsewhere but none on THIS module correctly reads as "no data".
  const allSessions = Array.isArray(progress?.attentionSessions) ? progress.attentionSessions : [];
  const sessions = moduleId
    ? allSessions.filter((sess) => String((sess as any)?.moduleId || "") === moduleId)
    : allSessions;
  const focusScores = sessions
    .map((sess) => Number((sess as any)?.avgFocusScore))
    .filter((v) => Number.isFinite(v));

  const createdAt = profile?.createdAt ? new Date(profile.createdAt).getTime() : Date.now();
  const lastLoginAt = profile?.lastLoginDate ? new Date(profile.lastLoginDate).getTime() : null;
  const scheduleStartAt = scheduleStartDate ? new Date(scheduleStartDate).getTime() : null;

  return computePredictionFeatures({
    completedCount,
    totalSubAcquis,
    quizScores,
    quizTimestamps,
    loginCount: Number(profile?.loginCount || 0),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    lastLoginAt: lastLoginAt && Number.isFinite(lastLoginAt) ? lastLoginAt : null,
    scheduleStartAt: scheduleStartAt && Number.isFinite(scheduleStartAt) ? scheduleStartAt : null,
    focusScores,
    now: Date.now()
  });
}

export type PredictionModuleInfo = { id: string; name: string; subAcquisCount: number };
