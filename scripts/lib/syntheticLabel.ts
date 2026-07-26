/**
 * syntheticLabel.ts
 *
 * The one and only definition of the synthetic "success propensity" label model.
 *
 * There are no real end-of-term outcomes yet, so both the training labels and the
 * fresh-data test labels come from this documented latent model. It used to be
 * copy-pasted into generate-training-data.ts and test-on-fresh-data.ts, with a
 * comment promising the two were "identical" — they drifted the moment a feature
 * was added, and the fresh-data test silently started scoring the model against a
 * different target than it was trained on. Hence: one file, imported by both.
 *
 * IMPORTANT — read before changing the weights:
 * The label is an ASSERTION about what makes a student catch up, not a measurement.
 * The forest will faithfully reproduce whatever is asserted here, so any accuracy
 * figure is "how well the model recovers this formula", not "how well it predicts
 * reality". Keep the caveat in evaluate-models.ts honest.
 */

import {
  PREDICTION_FEATURE_KEYS,
  PREDICTION_FEATURE_RANGES,
  type PredictionFeatures
} from "../../src/services/prediction/features";

/**
 * Share of synthetic students who have any attention data.
 *
 * Attention tracking is consent-gated, so in production most students have none.
 * We train on a much higher rate than reality so the forest sees enough tracked
 * students to learn what focus means; the `hasAttentionData` indicator is what
 * lets it apply that knowledge only where the signal actually exists.
 */
export const ATTENTION_COVERAGE = 0.4;

/**
 * How much of the latent success score focus accounts for, for students who have
 * attention data. Below quiz average (0.24) and recency (0.20) on purpose: it is
 * an assumed relationship, so it should not dominate the signals we actually
 * measure for everyone.
 */
export const ATTENTION_WEIGHT = 0.15;

/**
 * Latent "propensity to catch up" in [0, 1]. The signs encode the intended
 * relationships: low delay, high pace, high score, frequent logins, low gap,
 * recent activity, few weak skills -> likely catches up.
 */
export function successPropensity(f: PredictionFeatures): number {
  const norm = {
    delay: 1 - f.delayWeeks / 12, // 1 = on time
    score: f.averageScore / 100,
    login: f.loginFrequency / 14,
    coverage: 1 - f.gapDepth, // 1 = fully covered
    recency: f.recencyRatio,
    strength: 1 - f.weakSkillRatio // 1 = no weak skills
  };

  // Weighted sum of the behavioural features (weights sum to 1). The former
  // completionPace weight (0.16) was folded into score when that feature was
  // dropped from the model.
  const base =
    0.4 * norm.score +
    0.2 * norm.recency +
    0.14 * norm.delay +
    0.12 * norm.strength +
    0.08 * norm.coverage +
    0.06 * norm.login;

  // Focus only speaks for students who have attention data. A student without it
  // keeps `base` untouched, so never consenting to the webcam can neither help nor
  // hurt their prediction. That neutrality is a design promise — preserve it.
  const raw =
    f.hasAttentionData >= 0.5
      ? (1 - ATTENTION_WEIGHT) * base + ATTENTION_WEIGHT * (f.avgFocusScore / 100)
      : base;

  return Math.max(0, Math.min(1, raw));
}

/** Binary label with realistic noise, so the classes overlap and cannot be memorised. */
export function labelFromPropensity(propensity: number, rng: () => number): number {
  const noise = (rng() - 0.5) * 0.35;
  return propensity + noise >= 0.5 ? 1 : 0;
}

/** Exam grade /20 from the same latent model, keeping a direct link to quiz scores. */
export function gradeFromPropensity(
  propensity: number,
  f: PredictionFeatures,
  rng: () => number
): number {
  const base = 0.7 * propensity + 0.3 * (f.averageScore / 100);
  const noise = (rng() - 0.5) * 3.5; // ±1.75 points
  const grade = 1 + base * 18 + noise;
  return Math.max(0, Math.min(20, Math.round(grade * 4) / 4));
}

/**
 * Draws one random feature vector.
 *
 * Focus is drawn INDEPENDENTLY of everything else and only then allowed to
 * influence the label (see successPropensity). Deriving it from the label instead
 * would leak the target and make the model look far better than it is.
 */
export function drawSyntheticFeatures(rng: () => number): PredictionFeatures {
  const hasAttentionData = rng() < ATTENTION_COVERAGE ? 1 : 0;
  const features = {} as PredictionFeatures;

  for (const key of PREDICTION_FEATURE_KEYS) {
    if (key === "hasAttentionData") {
      features[key] = hasAttentionData;
    } else if (key === "avgFocusScore") {
      features[key] = hasAttentionData ? rng() * 100 : 0;
    } else {
      const [min, max] = PREDICTION_FEATURE_RANGES[key];
      features[key] = min + rng() * (max - min);
    }
  }

  return features;
}
