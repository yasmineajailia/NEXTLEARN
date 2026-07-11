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
 * SHAP background reference E[X] — the mean feature vector of the training set
 * (data/student_analytics.csv, 1234 rows). Shapley values are additive relative
 * to this baseline: Σ φ_i = predict(x) − predict(background), where
 * predict(background) ≈ the population's average catch-up probability (~0.50).
 * Regenerate these means if the training data changes materially.
 */
export const PREDICTION_FEATURE_BACKGROUND: PredictionFeatures = {
  delayWeeks: 6.0567,
  completionPace: 2.4274,
  averageScore: 50.7072,
  loginFrequency: 6.9312,
  gapDepth: 0.4908,
  recencyRatio: 0.4919,
  weakSkillRatio: 0.4996
};

/**
 * Exact SHAP (Shapley) values for one prediction. With only 7 features we can
 * enumerate all 2^7 feature coalitions, so these are EXACT Shapley values (no
 * sampling/approximation) under an interventional background reference.
 *
 * For a coalition S, "absent" features take their {@link PREDICTION_FEATURE_BACKGROUND}
 * value and "present" features take the student's actual value; f(S) is the model's
 * prediction on that hybrid vector. Each φ_i is the coalition-size-weighted average
 * marginal contribution of feature i. Guarantees additivity: Σ φ_i = f(x) − f(∅).
 *
 * @param features   the student's feature vector.
 * @param predict    the model's prediction fn (injected to keep this module model-agnostic).
 * @param background the reference vector (defaults to the training-set mean).
 * @returns per-feature signed contribution to the catch-up probability.
 */
export function computeShapValues(
  features: PredictionFeatures,
  predict: (f: PredictionFeatures) => number,
  background: PredictionFeatures = PREDICTION_FEATURE_BACKGROUND
): Record<PredictionFeatureKey, number> {
  const keys = PREDICTION_FEATURE_KEYS;
  const M = keys.length;

  // Feature record for a coalition bitmask: bit k set → actual value, else background.
  const vectorForMask = (mask: number): PredictionFeatures => {
    const out = {} as PredictionFeatures;
    for (let k = 0; k < M; k++) {
      out[keys[k]] = mask & (1 << k) ? features[keys[k]] : background[keys[k]];
    }
    return out;
  };

  // Memoize the model output for each of the 2^M distinct coalitions.
  const fCache = new Map<number, number>();
  const f = (mask: number): number => {
    let v = fCache.get(mask);
    if (v === undefined) {
      v = predict(vectorForMask(mask));
      fCache.set(mask, v);
    }
    return v;
  };

  // Shapley weight for a subset of the OTHER features of size s: s!(M-s-1)!/M!.
  const fact: number[] = [1];
  for (let i = 1; i <= M; i++) fact[i] = fact[i - 1] * i;
  const weight = (s: number): number => (fact[s] * fact[M - s - 1]) / fact[M];

  const shap = {} as Record<PredictionFeatureKey, number>;
  for (let i = 0; i < M; i++) {
    const others: number[] = [];
    for (let k = 0; k < M; k++) if (k !== i) others.push(k);

    let phi = 0;
    const subsets = 1 << (M - 1); // 2^(M-1) subsets of the other features
    for (let sub = 0; sub < subsets; sub++) {
      let mask = 0;
      let size = 0;
      for (let b = 0; b < others.length; b++) {
        if (sub & (1 << b)) {
          mask |= 1 << others[b];
          size++;
        }
      }
      phi += weight(size) * (f(mask | (1 << i)) - f(mask));
    }
    shap[keys[i]] = phi;
  }

  return shap;
}

/** French label for a SHAP factor — phrased as a risk when negative, protective when positive. */
function shapFactorLabel(key: PredictionFeatureKey, f: PredictionFeatures, positive: boolean): string {
  switch (key) {
    case "delayWeeks":
      return positive
        ? "Bonne avance sur le planning"
        : `Retard d'environ ${Math.round(f.delayWeeks)} semaine${f.delayWeeks >= 2 ? "s" : ""}`;
    case "averageScore":
      return positive ? `Bons scores aux quiz (${Math.round(f.averageScore)}%)` : `Score moyen faible (${Math.round(f.averageScore)}%)`;
    case "recencyRatio":
      return positive
        ? "Activité régulière et récente"
        : f.recencyRatio <= 0
          ? "Aucune activité récente"
          : "Peu d'activité récente";
    case "weakSkillRatio":
      return positive ? "Peu de quiz en difficulté" : `${Math.round(f.weakSkillRatio * 100)}% de quiz en difficulté`;
    case "gapDepth":
      return positive ? "Bonne progression dans le programme" : `${Math.round(f.gapDepth * 100)}% du programme non commencé`;
    case "loginFrequency":
      return positive ? "Connexions fréquentes" : "Connexions rares";
    case "completionPace":
      return positive ? `Bon rythme (${f.completionPace.toFixed(1)}/sem)` : `Rythme lent (${f.completionPace.toFixed(1)}/sem)`;
    default:
      return String(key);
  }
}

/**
 * Model-derived risk explanation: ranks the factors by their EXACT SHAP impact
 * on THIS student's catch-up probability, so the reasons shown actually reflect
 * what the model used — not hand-tuned heuristics like {@link explainRiskFactors}.
 *
 * Negative SHAP = the feature lowers the catch-up chance (a risk driver); positive
 * = protective. Returns the top risk drivers, or the strongest protective factor
 * when the student has none.
 *
 * @param features the student's feature vector.
 * @param predict  the model's prediction fn.
 * @returns risk factors ordered most-impactful first, each carrying its signed `impact`.
 */
export function explainRiskFactorsFromShap(
  features: PredictionFeatures,
  predict: (f: PredictionFeatures) => number,
  background: PredictionFeatures = PREDICTION_FEATURE_BACKGROUND
): RiskFactor[] {
  const shap = computeShapValues(features, predict, background);
  const entries = PREDICTION_FEATURE_KEYS.map((key) => ({ key, value: shap[key] }));

  // Only surface contributions above a small threshold to avoid noise.
  const drivers = entries.filter((e) => e.value <= -0.02).sort((a, b) => a.value - b.value);

  if (drivers.length > 0) {
    return drivers.slice(0, 3).map((d) => ({
      feature: d.key,
      label: shapFactorLabel(d.key, features, false),
      level: d.value <= -0.15 ? "high" : "medium",
      impact: d.value
    }));
  }

  // No risk drivers — highlight the strongest protective factor instead.
  const protectors = entries.filter((e) => e.value >= 0.03).sort((a, b) => b.value - a.value);
  if (protectors.length > 0) {
    const p = protectors[0];
    return [{ feature: p.key, label: shapFactorLabel(p.key, features, true), level: "good", impact: p.value }];
  }

  return [{ label: "Progression saine, aucun signal de risque", level: "good" }];
}

/**
 * SHAP explanation for the exam-grade regression: same exact-Shapley machinery,
 * but `predict` returns a grade on /20 so impacts are in GRADE POINTS
 * (e.g. -1.2 = this feature costs the student about 1.2 points).
 */
export function explainGradeFactorsFromShap(
  features: PredictionFeatures,
  predictGrade: (f: PredictionFeatures) => number,
  background: PredictionFeatures = PREDICTION_FEATURE_BACKGROUND
): { factors: RiskFactor[]; shapValues: Record<PredictionFeatureKey, number> } {
  const shapValues = computeShapValues(features, predictGrade, background);
  const entries = PREDICTION_FEATURE_KEYS.map((key) => ({ key, value: shapValues[key] }));

  const drivers = entries.filter((e) => e.value <= -0.5).sort((a, b) => a.value - b.value);
  if (drivers.length > 0) {
    return {
      shapValues,
      factors: drivers.slice(0, 3).map((d) => ({
        feature: d.key,
        label: shapFactorLabel(d.key, features, false),
        level: d.value <= -2 ? "high" : "medium",
        impact: d.value
      }))
    };
  }

  const protectors = entries.filter((e) => e.value >= 0.5).sort((a, b) => b.value - a.value);
  if (protectors.length > 0) {
    const p = protectors[0];
    return {
      shapValues,
      factors: [{ feature: p.key, label: shapFactorLabel(p.key, features, true), level: "good", impact: p.value }]
    };
  }

  return { shapValues, factors: [] };
}

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
