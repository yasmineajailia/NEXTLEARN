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
  "completionPace",
  "averageScore",
  "loginFrequency",
  "gapDepth",
  "recencyRatio",
  "weakSkillRatio"
] as const;

export type PredictionFeatureKey = (typeof PREDICTION_FEATURE_KEYS)[number];

export type PredictionFeatures = Record<PredictionFeatureKey, number>;

/** Valid [min, max] range per feature — used for clamping and training jitter. */
export const PREDICTION_FEATURE_RANGES: Record<PredictionFeatureKey, [number, number]> = {
  delayWeeks: [0, 12],
  completionPace: [0, 5],
  averageScore: [0, 100],
  loginFrequency: [0, 14],
  gapDepth: [0, 1],
  recencyRatio: [0, 1],
  weakSkillRatio: [0, 1]
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

  const completionPace = clamp(completedCount / weeksSinceCreation, 0, 5);

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

  return {
    delayWeeks,
    completionPace,
    averageScore,
    loginFrequency,
    gapDepth,
    recencyRatio,
    weakSkillRatio
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
};

/**
 * Turns a feature vector into a ranked, human-readable list of the factors
 * driving a student's risk — so the dashboard can explain *why* a score is low,
 * not just show a number. Rule-based and deterministic (no model needed).
 *
 * @param features - the student's computed feature vector.
 * @returns risk factors ordered most-severe first; a single "good" factor if none apply.
 */
export function explainRiskFactors(features: PredictionFeatures): RiskFactor[] {
  const factors: Array<RiskFactor & { weight: number }> = [];

  if (features.delayWeeks >= 4) {
    factors.push({
      label: `Retard d'environ ${Math.round(features.delayWeeks)} semaine${features.delayWeeks >= 2 ? "s" : ""}`,
      level: features.delayWeeks >= 8 ? "high" : "medium",
      weight: features.delayWeeks / 12
    });
  }
  if (features.averageScore < 60) {
    factors.push({
      label: `Score moyen faible (${Math.round(features.averageScore)}%)`,
      level: features.averageScore < 40 ? "high" : "medium",
      weight: (60 - features.averageScore) / 60
    });
  }
  if (features.recencyRatio < 0.35) {
    factors.push({
      label: features.recencyRatio <= 0 ? "Aucune activité récente" : "Peu d'activité récente",
      level: features.recencyRatio < 0.15 ? "high" : "medium",
      weight: 1 - features.recencyRatio
    });
  }
  if (features.weakSkillRatio > 0.4) {
    factors.push({
      label: `${Math.round(features.weakSkillRatio * 100)}% de quiz en difficulté`,
      level: features.weakSkillRatio > 0.6 ? "high" : "medium",
      weight: features.weakSkillRatio
    });
  }
  if (features.gapDepth > 0.6) {
    factors.push({
      label: `${Math.round(features.gapDepth * 100)}% du programme non commencé`,
      level: features.gapDepth > 0.85 ? "high" : "medium",
      weight: features.gapDepth
    });
  }
  if (features.loginFrequency < 1) {
    factors.push({
      label: "Connexions rares",
      level: "medium",
      weight: 0.5
    });
  }
  if (features.completionPace < 1) {
    factors.push({
      label: `Rythme lent (${features.completionPace.toFixed(1)}/sem)`,
      level: "medium",
      weight: 0.4
    });
  }

  if (factors.length === 0) {
    return [{ label: "Progression saine, aucun signal de risque", level: "good" }];
  }

  return factors
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map(({ label, level }) => ({ label, level }));
}
