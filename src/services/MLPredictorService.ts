/**
 * MLPredictorService.ts
 *
 * Random Forest classifier that predicts the probability that a late student
 * will catch up before exams.
 *
 * Features:
 *   [0] delayWeeks        – weeks since course start with no activity (0 = on time, 8 = very late)
 *   [1] completionPace    – sub-acquis completed per week  (0 = inactive, 5 = very active)
 *   [2] averageScore      – mean quiz score on 100  (0-100)
 *   [3] loginFrequency    – logins per week  (0-14)
 *   [4] gapDepth          – fraction of sub-acquis not yet touched  (0 = fully covered, 1 = nothing done)
 *
 * Output: probability in [0, 1] that the student will catch up.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RandomForestClassifier } = require("ml-random-forest");

export type PredictionFeatures = {
  delayWeeks: number;
  completionPace: number;
  averageScore: number;
  loginFrequency: number;
  gapDepth: number;
};

type RFClassifier = {
  train: (X: number[][], y: number[]) => void;
  predict: (X: number[][]) => number[];
};

// ---------------------------------------------------------------------------
// Synthetic dataset generation (OULAD-inspired distributions)
// ---------------------------------------------------------------------------

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Generates n synthetic student feature rows and their labels.
 * The outcome probability follows OULAD research findings:
 *  - More delay  → lower success
 *  - Higher pace → higher success
 *  - Higher score → higher success
 *  - Higher frequency → higher success
 *  - Higher gap depth → lower success
 */
function generateSyntheticDataset(n = 1200): { X: number[][]; y: number[] } {
  const X: number[][] = [];
  const y: number[] = [];

  for (let i = 0; i < n; i++) {
    const delay = clamp(rand(0, 9) + (Math.random() > 0.6 ? rand(0, 4) : 0), 0, 12);
    const pace = clamp(rand(0, 5) - delay * 0.15 + rand(-0.5, 0.5), 0, 5);
    const score = clamp(rand(0, 100) - delay * 4 + pace * 8 + rand(-10, 10), 0, 100);
    const loginFreq = clamp(rand(0, 14) - delay * 0.5 + pace * 0.8 + rand(-1, 1), 0, 14);
    const gapDepth = clamp(1 - pace / 5 + delay / 12 + rand(-0.1, 0.1), 0, 1);

    // Success probability: logistic-style combination
    const logit =
      -2.0 +
      -0.25 * delay +
      0.55 * pace +
      0.04 * score +
      0.18 * loginFreq +
      -2.5 * gapDepth;

    const prob = 1 / (1 + Math.exp(-logit));
    const label = Math.random() < prob ? 1 : 0;

    X.push([delay, pace, score, loginFreq, gapDepth]);
    y.push(label);
  }

  return { X, y };
}

// ---------------------------------------------------------------------------
// Service singleton
// ---------------------------------------------------------------------------

class MLPredictorServiceImpl {
  private classifier: RFClassifier | null = null;
  private ready = false;

  async initialize(): Promise<void> {
    console.log("[ML] Training Random Forest on synthetic OULAD dataset...");
    const t0 = Date.now();

    const { X, y } = generateSyntheticDataset(1200);

    this.classifier = new RandomForestClassifier({
      nEstimators: 80,
      maxDepth: 8,
      minNumSamples: 5,
      seed: 42
    }) as RFClassifier;

    this.classifier.train(X, y);
    this.ready = true;

    const elapsed = Date.now() - t0;
    console.log(`[ML] Random Forest trained in ${elapsed}ms (1200 samples, 80 trees).`);
  }

  /**
   * Predict catch-up probability for a single student.
   * Returns a number in [0, 1].
   */
  predict(features: PredictionFeatures): number {
    if (!this.ready || !this.classifier) {
      // Return a neutral estimate if model not ready
      return 0.5;
    }

    const row = [
      clamp(features.delayWeeks, 0, 12),
      clamp(features.completionPace, 0, 5),
      clamp(features.averageScore, 0, 100),
      clamp(features.loginFrequency, 0, 14),
      clamp(features.gapDepth, 0, 1)
    ];

    try {
      // Run a small ensemble vote: run predict N times with jitter for probability estimate
      const votes = 20;
      let positiveCount = 0;
      for (let i = 0; i < votes; i++) {
        // Tiny noise to sample the decision boundary
        const jittered = row.map((v, idx) => {
          const noise = (Math.random() - 0.5) * [0.3, 0.1, 2, 0.3, 0.03][idx];
          return clamp(v + noise, 0, [12, 5, 100, 14, 1][idx]);
        });
        const result = this.classifier!.predict([jittered]);
        if (result[0] === 1) positiveCount++;
      }
      return parseFloat((positiveCount / votes).toFixed(2));
    } catch (err) {
      console.error("[ML] Prediction error:", err);
      return 0.5;
    }
  }

  isReady(): boolean {
    return this.ready;
  }
}

export const MLPredictorService = new MLPredictorServiceImpl();
