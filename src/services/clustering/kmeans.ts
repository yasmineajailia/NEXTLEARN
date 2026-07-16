/**
 * kmeans.ts
 *
 * Feature engineering + min-max normalization for learning-profile clustering:
 * turns a student's raw progress data into a 6-dimensional numeric vector and
 * scales a cohort to [0, 1]. Nothing here touches MongoDB or Express.
 *
 * The K-Means algorithm itself now runs in the Python ML service (scikit-learn);
 * `runKMeans` lives in `kmeansClient.ts`, which posts these normalized vectors to
 * `POST /cluster`. This file stays pure, deterministic and easy to unit test.
 */

// ---------------------------------------------------------------------------
// Feature vector
// ---------------------------------------------------------------------------

/** Ordered list of the 6 features that make up a student's clustering vector. */
export const FEATURE_KEYS = [
  "completionRate",
  "avgQuizScore",
  "quizAttemptRate",
  "weeklyLoginFrequency",
  "progressVelocity",
  "weakSkillRatio"
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** A student's 6 behavioral/performance features, keyed by feature name. */
export type StudentFeatures = Record<FeatureKey, number>;

/** Fallback curriculum size used when the live count cannot be resolved from the database. */
export const TOTAL_SUB_ACQUIS = 84;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENCY_WINDOW_DAYS = 14;
const WEAK_SCORE_THRESHOLD = 60;
const MAX_WEEKLY_LOGIN_FREQUENCY = 7;

// ---------------------------------------------------------------------------
// Raw input contract
// ---------------------------------------------------------------------------

/** A single quiz submission as read from a student's progress history. */
export type RawQuizResult = {
  moduleId: string;
  subAcquisId: string;
  score: number;
  submittedAt: string | Date;
  /** Explicit attempt count for this quiz, if the source tracks it. */
  attempts?: number;
};

/** Minimal per-student data required to compute a feature vector. */
export type RawStudentData = {
  identifier: string;
  fullName: string;
  completedLessonKeys: string[];
  quizResults: RawQuizResult[];
  /** Timestamps of every login (ISO strings or Date objects). */
  loginHistory: Array<string | Date>;
  createdAt: string | Date;
};

// ---------------------------------------------------------------------------
// Small numeric helpers (all NaN / divide-by-zero safe)
// ---------------------------------------------------------------------------

function toSafeDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// Feature engineering
// ---------------------------------------------------------------------------

/**
 * Computes the 6 raw (pre-normalization) features for a single student.
 *
 * Design notes:
 * - `avgQuizScore` and `weakSkillRatio` are computed from the *latest*
 *   submission of each unique quiz (`moduleId::subAcquisId`), so retries
 *   that eventually succeed are not dragged down by earlier failed
 *   attempts. The number of submissions observed per quiz feeds
 *   `quizAttemptRate` instead (an explicit `attempts` field is trusted
 *   when present, otherwise the submission count is used as a proxy).
 * - `progressVelocity` approximates "lessons completed in the last 14
 *   days" using quiz submission timestamps for sub-acquis that are marked
 *   completed, since completed-lesson keys carry no per-item timestamp in
 *   the source data. Completed items with no associated quiz submission
 *   cannot be dated and are excluded from the recent-count numerator,
 *   making this a conservative (lower-bound) estimate.
 * - Every division is guarded against zero/NaN denominators via
 *   {@link safeDivide}, and every output is clamped to a sane range.
 *
 * @param student - the student's raw progress data.
 * @param options.totalSubAcquis - live curriculum size; falls back to {@link TOTAL_SUB_ACQUIS}.
 * @param options.now - reference "current time"; defaults to `new Date()` (useful for tests).
 * @returns the student's raw 6-feature vector.
 */
export function computeFeatureVector(
  student: RawStudentData,
  options: { totalSubAcquis?: number; now?: Date } = {}
): StudentFeatures {
  const totalSubAcquis =
    typeof options.totalSubAcquis === "number" && options.totalSubAcquis > 0
      ? options.totalSubAcquis
      : TOTAL_SUB_ACQUIS;
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();

  const completedKeys = Array.isArray(student.completedLessonKeys) ? student.completedLessonKeys : [];
  const quizResults = Array.isArray(student.quizResults) ? student.quizResults : [];
  const loginHistory = Array.isArray(student.loginHistory) ? student.loginHistory : [];

  // --- completionRate ---
  const completionRate = clamp01(safeDivide(completedKeys.length, totalSubAcquis));

  // --- group quiz submissions by unique quiz ---
  const quizGroups = new Map<string, RawQuizResult[]>();
  for (const result of quizResults) {
    if (!result || typeof result.score !== "number" || Number.isNaN(result.score)) continue;
    const key = `${result.moduleId || ""}::${result.subAcquisId || ""}`;
    const bucket = quizGroups.get(key);
    if (bucket) bucket.push(result);
    else quizGroups.set(key, [result]);
  }

  const latestScores: number[] = [];
  const attemptCounts: number[] = [];
  for (const bucket of quizGroups.values()) {
    const sorted = [...bucket].sort((a, b) => {
      const timeA = toSafeDate(a.submittedAt)?.getTime() ?? 0;
      const timeB = toSafeDate(b.submittedAt)?.getTime() ?? 0;
      return timeA - timeB;
    });
    const latest = sorted[sorted.length - 1];
    latestScores.push(Math.max(0, Math.min(100, latest.score)));

    let explicitAttempts = 0;
    for (const record of bucket) {
      if (typeof record.attempts === "number" && record.attempts > explicitAttempts) {
        explicitAttempts = record.attempts;
      }
    }
    attemptCounts.push(explicitAttempts > 0 ? explicitAttempts : bucket.length);
  }

  const totalQuizzes = latestScores.length;
  const avgQuizScore = totalQuizzes > 0 ? safeDivide(latestScores.reduce((sum, v) => sum + v, 0), totalQuizzes) : 0;
  const quizAttemptRate =
    totalQuizzes > 0 ? safeDivide(attemptCounts.reduce((sum, v) => sum + v, 0), totalQuizzes) : 0;
  const weakSkillRatio =
    totalQuizzes > 0
      ? clamp01(safeDivide(latestScores.filter((score) => score < WEAK_SCORE_THRESHOLD).length, totalQuizzes))
      : 0;

  // --- weeklyLoginFrequency ---
  const createdAt = toSafeDate(student.createdAt) ?? now;
  const daysSinceCreation = Math.max(0, (now.getTime() - createdAt.getTime()) / MS_PER_DAY);
  // Floor at 1 week so day-old accounts aren't divided by a near-zero denominator.
  const weeksSinceCreation = Math.max(1, daysSinceCreation / 7);
  const weeklyLoginFrequency = Math.min(
    MAX_WEEKLY_LOGIN_FREQUENCY,
    safeDivide(loginHistory.length, weeksSinceCreation)
  );

  // --- progressVelocity (recency proxy, see design notes above) ---
  const completedSet = new Set(completedKeys);
  const recentCutoff = now.getTime() - RECENCY_WINDOW_DAYS * MS_PER_DAY;
  const datedRecentKeys = new Set<string>();
  for (const [key, bucket] of quizGroups) {
    if (!completedSet.has(key) || datedRecentKeys.has(key)) continue;
    for (const result of bucket) {
      const submittedAt = toSafeDate(result.submittedAt);
      if (submittedAt && submittedAt.getTime() >= recentCutoff) {
        datedRecentKeys.add(key);
        break;
      }
    }
  }
  const progressVelocity =
    completedKeys.length > 0 ? clamp01(safeDivide(datedRecentKeys.size, completedKeys.length)) : 0;

  return {
    completionRate,
    avgQuizScore,
    quizAttemptRate,
    weeklyLoginFrequency,
    progressVelocity,
    weakSkillRatio
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export type NormalizationResult = {
  normalized: StudentFeatures[];
  /** False when every student produced an identical value on every dimension. */
  hasVariance: boolean;
  min: StudentFeatures;
  max: StudentFeatures;
};

/**
 * Min-max normalizes a set of raw feature vectors to [0, 1], dimension by
 * dimension, across the whole dataset.
 *
 * If a dimension has zero range (every student has the same value), that
 * dimension is normalized to a neutral 0.5 for every student rather than
 * dividing by zero. If *every* dimension has zero range, `hasVariance` is
 * false and callers should treat the dataset as a single, undifferentiated
 * group instead of running K-Means on it.
 *
 * @param rawFeatures - one raw feature vector per student.
 * @returns the normalized vectors alongside variance metadata and the observed min/max per dimension.
 */
export function normalizeFeatures(rawFeatures: StudentFeatures[]): NormalizationResult {
  const min = {} as StudentFeatures;
  const max = {} as StudentFeatures;

  for (const key of FEATURE_KEYS) {
    let dimMin = Infinity;
    let dimMax = -Infinity;
    for (const features of rawFeatures) {
      const value = Number.isFinite(features[key]) ? features[key] : 0;
      if (value < dimMin) dimMin = value;
      if (value > dimMax) dimMax = value;
    }
    if (!Number.isFinite(dimMin) || !Number.isFinite(dimMax)) {
      dimMin = 0;
      dimMax = 0;
    }
    min[key] = dimMin;
    max[key] = dimMax;
  }

  const hasVariance = FEATURE_KEYS.some((key) => max[key] - min[key] > 1e-9);

  const normalized = rawFeatures.map((features) => {
    const out = {} as StudentFeatures;
    for (const key of FEATURE_KEYS) {
      const range = max[key] - min[key];
      const value = Number.isFinite(features[key]) ? features[key] : 0;
      out[key] = range > 1e-9 ? clamp01((value - min[key]) / range) : 0.5;
    }
    return out;
  });

  return { normalized, hasVariance, min, max };
}

/** Converts a StudentFeatures record into an ordered numeric vector (see {@link FEATURE_KEYS}). */
export function featuresToVector(features: StudentFeatures): number[] {
  return FEATURE_KEYS.map((key) => (Number.isFinite(features[key]) ? features[key] : 0));
}

/** Converts an ordered numeric vector back into a StudentFeatures record (see {@link FEATURE_KEYS}). */
export function vectorToFeatures(vector: number[]): StudentFeatures {
  const out = {} as StudentFeatures;
  FEATURE_KEYS.forEach((key, index) => {
    const value = vector[index];
    out[key] = Number.isFinite(value) ? value : 0;
  });
  return out;
}

/** Averages a list of feature vectors dimension by dimension. Returns all-zero if the list is empty. */
export function averageFeatures(list: StudentFeatures[]): StudentFeatures {
  const out = {} as StudentFeatures;
  for (const key of FEATURE_KEYS) {
    const sum = list.reduce((acc, features) => acc + (Number.isFinite(features[key]) ? features[key] : 0), 0);
    out[key] = list.length > 0 ? sum / list.length : 0;
  }
  return out;
}
