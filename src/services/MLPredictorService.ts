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
const { RandomForestClassifier, RandomForestRegression } = require("ml-random-forest");

export type { PredictionFeatures } from "./prediction/features";

type RFClassifier = {
  train: (X: number[][], y: number[]) => void;
  predict: (X: number[][]) => number[];
  toJSON: () => object;
};

const MODEL_PATH = path.join(process.cwd(), "data", "rf-model.json");
const GRADE_MODEL_PATH = path.join(process.cwd(), "data", "rf-grade-model.json");

// ---------------------------------------------------------------------------
// Service singleton
// ---------------------------------------------------------------------------

class MLPredictorServiceImpl {
  private classifier: RFClassifier | null = null;
  private gradeRegressor: RFClassifier | null = null;
  private ready = false;
  private gradeReady = false;

  async initialize(): Promise<void> {
    if (!fs.existsSync(MODEL_PATH)) {
      console.warn(
        "[ML] ⚠️  No pre-trained model found at data/rf-model.json.\n" +
        "[ML]     Run `npm run train:model` once to train and save the model.\n" +
        "[ML]     Predictions will return 0.5 (neutral) until the model is loaded."
      );
    } else {
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

    if (!fs.existsSync(GRADE_MODEL_PATH)) {
      console.warn(
        "[ML] ⚠️  No grade model at data/rf-grade-model.json — run `npm run train:grade-model`.\n" +
        "[ML]     Grade predictions will be unavailable until then."
      );
    } else {
      try {
        const t0 = Date.now();
        const raw = fs.readFileSync(GRADE_MODEL_PATH, "utf8");
        this.gradeRegressor = RandomForestRegression.load(JSON.parse(raw)) as RFClassifier;
        this.gradeReady = true;
        console.log(`[ML] ✅ Grade regression loaded in ${Date.now() - t0}ms.`);
      } catch (err) {
        console.error("[ML] Failed to load grade model:", err);
      }
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

  /**
   * Predict the student's expected exam grade on /20.
   * Returns null when the grade model isn't loaded.
   */
  predictGrade(features: PredictionFeatures): number | null {
    if (!this.gradeReady || !this.gradeRegressor) {
      return null;
    }

    const row = predictionFeaturesToVector(features);

    try {
      const preds = this.gradeRegressor.predict([row]);
      const grade = Number(preds[0]);
      if (!Number.isFinite(grade)) return null;
      return Math.max(0, Math.min(20, Math.round(grade * 10) / 10));
    } catch (err) {
      console.error("[ML] Grade prediction error:", err);
      return null;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  isGradeReady(): boolean {
    return this.gradeReady;
  }
}

export const MLPredictorService = new MLPredictorServiceImpl();
