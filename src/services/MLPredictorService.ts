/**
 * MLPredictorService.ts
 *
 * Random Forest classifier that predicts the probability that a late student
 * will catch up before exams. The feature vector is defined centrally in
 * services/prediction/features.ts (shared with the API and training scripts).
 *
 * Features (see PREDICTION_FEATURE_KEYS):
 *   [0] delayWeeks      – weeks behind the expected pace (schedule-aware)  0-12
 *   [1] completionPace  – sous-acquis completed per week                    0-5
 *   [2] averageScore    – mean quiz score on 100                            0-100
 *   [3] loginFrequency  – logins per week                                   0-14
 *   [4] gapDepth        – fraction of curriculum not yet started            0-1
 *   [5] recencyRatio    – how recently active (1 = today, 0 = dormant)      0-1
 *   [6] weakSkillRatio  – fraction of quizzes scored below 60               0-1
 *
 * Output: probability in [0, 1] that the student will catch up.
 *
 * The model is loaded from data/rf-model.json (pre-trained by `npm run train:model`).
 * If the file is missing, the service falls back to a neutral estimate of 0.5.
 */

import fs from "node:fs";
import path from "node:path";
import {
  PredictionFeatures,
  predictionFeaturesToVector
} from "./prediction/features";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RandomForestClassifier } = require("ml-random-forest");

export type { PredictionFeatures } from "./prediction/features";

type RFClassifier = {
  train: (X: number[][], y: number[]) => void;
  predict: (X: number[][]) => number[];
  toJSON: () => object;
};

const MODEL_PATH = path.join(process.cwd(), "data", "rf-model.json");

// ---------------------------------------------------------------------------
// Service singleton
// ---------------------------------------------------------------------------

class MLPredictorServiceImpl {
  private classifier: RFClassifier | null = null;
  private ready = false;

  async initialize(): Promise<void> {
    if (!fs.existsSync(MODEL_PATH)) {
      console.warn(
        "[ML] ⚠️  No pre-trained model found at data/rf-model.json.\n" +
        "[ML]     Run `npm run train:model` once to train and save the model.\n" +
        "[ML]     Predictions will return 0.5 (neutral) until the model is loaded."
      );
      return;
    }

    try {
      console.log("[ML] Loading pre-trained Random Forest from data/rf-model.json …");
      const t0 = Date.now();

      const raw = fs.readFileSync(MODEL_PATH, "utf8");
      const modelJson = JSON.parse(raw);

      this.classifier = RandomForestClassifier.load(modelJson) as RFClassifier;
      this.ready = true;

      console.log(`[ML] ✅ Random Forest loaded in ${Date.now() - t0}ms — ready to predict.`);
    } catch (err) {
      console.error("[ML] Failed to load model:", err);
      console.warn("[ML] Predictions will return 0.5 until the issue is resolved.");
    }
  }

  /**
   * Predict catch-up probability for a single student.
   * Returns a number in [0, 1].
   */
  predict(features: PredictionFeatures): number {
    if (!this.ready || !this.classifier) {
      return 0.5;
    }

    const row = predictionFeaturesToVector(features);

    try {
      // Use the built-in predictProbability method to get the fraction of trees voting for class 1
      const probs = (this.classifier as any).predictProbability([row], 1);
      return typeof probs[0] === "number" ? probs[0] : 0.5;
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
