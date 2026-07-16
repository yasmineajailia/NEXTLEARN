/**
 * MLPredictorService.ts
 *
 * Thin async client for the Python ML service (ml/shap_service.py). Every risk /
 * grade prediction is computed by scikit-learn there and fetched over HTTP —
 * there is NO in-process JS model anymore (the old ml-random-forest path and the
 * js_forest tree mirror were removed). The service is auto-started and kept alive
 * by shapSupervisor.ts, so "not reachable" is an error, not a silent fallback.
 *
 * Features (see PREDICTION_FEATURE_KEYS in prediction/features.ts):
 *   delayWeeks, completionPace, averageScore, loginFrequency, gapDepth,
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
   * Confirms the Python service is reachable and was trained on the feature list
   * this code sends. The supervisor is what actually starts the service; this is
   * a non-fatal health check (predictions still require the service to be up).
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
   * Throws if the service is unavailable — callers surface that as a 5xx.
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

  /** Live readiness = the shared circuit breaker isn't tripped (kept current by
   *  the supervisor's health monitor and by every predict/explain call). */
  isReady(): boolean {
    return !isShapServiceDown();
  }

  isGradeReady(): boolean {
    return !isShapServiceDown();
  }
}

export const MLPredictorService = new MLPredictorServiceImpl();
