/**
 * kmeans.ts
 *
 * Pure, dependency-free K-Means clustering engine plus the feature-engineering
 * logic that turns a student's raw progress data into a 6-dimensional numeric
 * vector. Nothing in this file touches MongoDB or Express — it operates only
 * on the plain data types declared below, which makes it trivial to unit
 * test and reuse outside the backoffice clustering route.
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

// ---------------------------------------------------------------------------
// K-Means algorithm
// ---------------------------------------------------------------------------

export type KMeansOptions = {
  maxIterations?: number;
  convergenceThreshold?: number;
  /** Injectable random source, primarily for deterministic unit tests. */
  rng?: () => number;
};

export type KMeansResult = {
  /** `assignments[i]` is the cluster index (0-based) assigned to `points[i]`. */
  assignments: number[];
  centroids: number[][];
  iterations: number;
  converged: boolean;
};

/** Euclidean distance between two equal-length numeric vectors. */
export function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * K-Means++ centroid initialization: the first centroid is picked uniformly
 * at random, and each subsequent centroid is picked with probability
 * proportional to its squared distance from the nearest centroid already
 * chosen. This spreads the initial centroids out and avoids the poor
 * convergence that plain-random initialization can produce.
 *
 * @param points - the dataset to seed centroids from.
 * @param k - number of centroids to produce (clamped to `points.length`).
 * @param rng - random source in [0, 1); defaults to `Math.random`.
 * @returns up to `k` seed centroids (fewer only if `points` is empty).
 */
export function kmeansPlusPlusInit(points: number[][], k: number, rng: () => number = Math.random): number[][] {
  if (points.length === 0 || k <= 0) return [];

  const effectiveK = Math.min(k, points.length);
  const centroids: number[][] = [];

  const firstIndex = Math.floor(rng() * points.length);
  centroids.push([...points[firstIndex]]);

  while (centroids.length < effectiveK) {
    const squaredDistances = points.map((point) => {
      let nearest = Infinity;
      for (const centroid of centroids) {
        const distance = euclideanDistance(point, centroid);
        if (distance < nearest) nearest = distance;
      }
      return nearest * nearest;
    });

    const totalWeight = squaredDistances.reduce((sum, value) => sum + value, 0);

    if (totalWeight <= 0) {
      // Every remaining point coincides with a chosen centroid; pick uniformly to keep progressing.
      centroids.push([...points[Math.floor(rng() * points.length)]]);
      continue;
    }

    let threshold = rng() * totalWeight;
    let chosenIndex = squaredDistances.length - 1;
    for (let i = 0; i < squaredDistances.length; i++) {
      threshold -= squaredDistances[i];
      if (threshold <= 0) {
        chosenIndex = i;
        break;
      }
    }
    centroids.push([...points[chosenIndex]]);
  }

  return centroids;
}

/**
 * Runs K-Means clustering to convergence (or until `maxIterations` is hit).
 *
 * Uses Euclidean distance for both the assignment step and the convergence
 * check (largest single-centroid movement between iterations). If an
 * update step would leave a cluster empty, that centroid is re-seeded at
 * the point currently farthest from all centroids, so no cluster silently
 * disappears mid-run.
 *
 * @param points - normalized feature vectors, one per student.
 * @param k - number of clusters to produce (clamped to `points.length`).
 * @param options.maxIterations - hard iteration cap (default 100).
 * @param options.convergenceThreshold - stop once max centroid movement drops below this (default 0.001).
 * @param options.rng - random source used for K-Means++ initialization.
 * @returns cluster assignments, final centroids, iteration count, and whether convergence was reached.
 */
export function runKMeans(points: number[][], k: number, options: KMeansOptions = {}): KMeansResult {
  const maxIterations = options.maxIterations ?? 100;
  const convergenceThreshold = options.convergenceThreshold ?? 0.001;
  const rng = options.rng ?? Math.random;

  if (points.length === 0 || k <= 0) {
    return { assignments: [], centroids: [], iterations: 0, converged: true };
  }

  let centroids = kmeansPlusPlusInit(points, k, rng);
  let assignments: number[] = new Array(points.length).fill(0);
  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;

    const newAssignments = points.map((point) => {
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const distance = euclideanDistance(point, centroids[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = c;
        }
      }
      return bestIndex;
    });

    const dims = points[0].length;
    const sums = centroids.map(() => new Array(dims).fill(0));
    const counts = centroids.map(() => 0);
    for (let i = 0; i < points.length; i++) {
      const clusterIndex = newAssignments[i];
      counts[clusterIndex]++;
      for (let d = 0; d < dims; d++) sums[clusterIndex][d] += points[i][d];
    }

    const newCentroids = centroids.map((_, clusterIndex) => {
      if (counts[clusterIndex] === 0) {
        let farthestPoint = points[0];
        let farthestDistance = -Infinity;
        for (const point of points) {
          let nearest = Infinity;
          for (const centroid of centroids) {
            nearest = Math.min(nearest, euclideanDistance(point, centroid));
          }
          if (nearest > farthestDistance) {
            farthestDistance = nearest;
            farthestPoint = point;
          }
        }
        return [...farthestPoint];
      }
      return sums[clusterIndex].map((sum) => sum / counts[clusterIndex]);
    });

    let maxMovement = 0;
    for (let c = 0; c < centroids.length; c++) {
      maxMovement = Math.max(maxMovement, euclideanDistance(centroids[c], newCentroids[c]));
    }

    centroids = newCentroids;
    assignments = newAssignments;

    if (maxMovement < convergenceThreshold) {
      converged = true;
      break;
    }
  }

  return { assignments, centroids, iterations, converged };
}
