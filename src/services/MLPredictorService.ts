/**
 * MLPredictorService.ts
 *
 * Client for the Python ML service (ml/shap_service.py) that computes risk/grade predictions.
 *
 * Features (see PREDICTION_FEATURE_KEYS in prediction/features.ts):
 *   delayWeeks, averageScore, loginFrequency, gapDepth,
 *   recencyRatio, weakSkillRatio, avgFocusScore, hasAttentionData
 */
import {
  PREDICTION_FEATURE_KEYS,
  PredictionFeatures,
  predictionFeaturesToVector
} from "./prediction/features";
import {
  SHAP_SERVICE_URL,
  SHAP_SERVICE_TIMEOUT_MS,
  isShapServiceDown,
  markShapServiceUp,
  markShapServiceDown
} from "./prediction/explain";

export type { PredictionFeatures } from "./prediction/features";

export type MlPrediction = { catchupProbability: number; predictedGrade: number | null };

const base = () => SHAP_SERVICE_URL.replace(/\/$/, "");

async function postJson<T>(pathname: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHAP_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base()}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`ML service ${pathname} -> ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

class MLPredictorServiceImpl {
  /**
   * Confirms the Python service is reachable and its features match our schema.
   */
  async initialize(): Promise<void> {
    try {
      const res = await fetch(`${base()}/health`);
      if (!res.ok) throw new Error(`health ${res.status}`);
      const data = (await res.json()) as { features?: string[] };
      markShapServiceUp();

      const served = data.features || [];
      const expected = [...PREDICTION_FEATURE_KEYS];
      const matches = served.length === expected.length && served.every((k, i) => k === expected[i]);
      if (!matches) {
        console.error(
          "[ML] ❌ FEATURE MISMATCH — the Python model was trained on a different feature list.\n" +
          `[ML]    served  : ${JSON.stringify(served)}\n` +
          `[ML]    expected: ${JSON.stringify(expected)}\n` +
          "[ML]    Retrain: python ml/train.py"
        );
      } else {
        console.log("[ML] ✅ Connected to Python ML service — predictions served by scikit-learn.");
      }
    } catch {
      console.warn(
        "[ML] ⚠️  Python ML service not reachable yet — the supervisor is starting it. " +
        "Predictions require this service (no JS fallback)."
      );
    }
  }

  /**
   * Batch predict: one HTTP round trip for many students. Order is preserved.
   */
  async predictBatch(list: PredictionFeatures[]): Promise<MlPrediction[]> {
    if (!list.length) return [];
    const instances = list.map(predictionFeaturesToVector);
    try {
      const data = await postJson<{ predictions?: MlPrediction[] }>("/predict", { instances });
      if (!Array.isArray(data.predictions) || data.predictions.length !== list.length) {
        throw new Error("ML service /predict returned a malformed payload");
      }
      markShapServiceUp();
      return data.predictions;
    } catch (err) {
      markShapServiceDown();
      throw err;
    }
  }

  /** Catch-up probability in [0, 1] for a single student. */
  async predict(features: PredictionFeatures): Promise<number> {
    const [p] = await this.predictBatch([features]);
    return p.catchupProbability;
  }

  /** Expected exam grade on /20, or null when the grade model isn't available. */
  async predictGrade(features: PredictionFeatures): Promise<number | null> {
    const [p] = await this.predictBatch([features]);
    return p.predictedGrade;
  }

  /** Live readiness based on SHAP service health */
  isReady(): boolean {
    return !isShapServiceDown();
  }

  isGradeReady(): boolean {
    return !isShapServiceDown();
  }
}

export const MLPredictorService = new MLPredictorServiceImpl();
