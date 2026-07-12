/**
 * Risk / grade explanation resolution.
 *
 * Prefers the real `shap` library served by the Python microservice
 * (ml/shap_service.py), falls back to the in-process exact-Shapley
 * implementation, then to rule-based heuristics — so an explanation is
 * always available even with every ML component down.
 */
import { MLPredictorService } from "../MLPredictorService";
import {
  type PredictionFeatures,
  type RiskFactor,
  computeShapValues,
  explainGradeFactorsFromShap,
  explainRiskFactors,
  explainRiskFactorsFromShap
} from "./features";

/**
 * Builds the risk explanation for a feature vector. Prefers EXACT SHAP values
 * (model-derived, faithful to the Random Forest) when the model is loaded, and
 * falls back to the rule-based heuristic when it isn't.
 */
export function buildRiskFactors(features: PredictionFeatures): RiskFactor[] {
  if (MLPredictorService.isReady()) {
    try {
      return explainRiskFactorsFromShap(features, (f) => MLPredictorService.predict(f));
    } catch (error) {
      console.warn("[ML] SHAP explanation failed; using rule-based factors:", error);
    }
  }
  return explainRiskFactors(features);
}

/** SHAP contributions per feature (for API transparency / charts); empty when the model isn't ready. */
export function buildShapValues(features: PredictionFeatures): Record<string, number> | undefined {
  if (!MLPredictorService.isReady()) return undefined;
  try {
    return computeShapValues(features, (f) => MLPredictorService.predict(f));
  } catch (error) {
    console.warn("[ML] SHAP value computation failed:", error);
    return undefined;
  }
}

// ── Real `shap` library integration (Python microservice) ──────────────────
// The Python service (ml/shap_service.py) serves canonical shap.TreeExplainer
// values. We call it when available and fall back to the in-process JS exact-
// Shapley implementation otherwise. A short circuit-breaker avoids paying the
// request timeout on every call while the service is down.
export const SHAP_SERVICE_URL = process.env.SHAP_SERVICE_URL || "http://127.0.0.1:8000";
export const SHAP_SERVICE_TIMEOUT_MS = 2500;
export const SHAP_SERVICE_BACKOFF_MS = 30_000;
export let shapServiceDownUntil = 0;

export type RiskExplanation = {
  riskFactors: RiskFactor[];
  shapValues: Record<string, number> | undefined;
  /** SHAP contributions to the predicted grade, in points /20. */
  gradeShapValues: Record<string, number> | undefined;
  /** Top drivers of the predicted grade (impacts in points /20). */
  gradeFactors: RiskFactor[] | undefined;
  /** "shap-python" = real shap lib, "shap-js" = exact JS Shapley, "rules" = heuristic fallback. */
  explainSource: "shap-python" | "shap-js" | "rules";
};

export type ShapServicePayload = {
  riskFactors: RiskFactor[];
  shapValues: Record<string, number> | undefined;
  gradeShapValues: Record<string, number> | undefined;
  gradeFactors: RiskFactor[] | undefined;
};

export async function fetchShapFromService(features: PredictionFeatures): Promise<ShapServicePayload | null> {
  if (Date.now() < shapServiceDownUntil) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHAP_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(features),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as {
      riskFactors?: RiskFactor[];
      shapValues?: Record<string, number>;
      gradeShapValues?: Record<string, number>;
      gradeFactors?: RiskFactor[];
    };
    if (!Array.isArray(data.riskFactors)) throw new Error("malformed payload");
    return {
      riskFactors: data.riskFactors,
      shapValues: data.shapValues,
      gradeShapValues: data.gradeShapValues,
      gradeFactors: Array.isArray(data.gradeFactors) ? data.gradeFactors : undefined
    };
  } catch (error) {
    // Back off so we don't hammer a down service with per-request timeouts.
    shapServiceDownUntil = Date.now() + SHAP_SERVICE_BACKOFF_MS;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** In-process exact-Shapley explanation of the grade prediction (fallback path). */
export function buildGradeExplanation(
  features: PredictionFeatures
): { gradeShapValues: Record<string, number> | undefined; gradeFactors: RiskFactor[] | undefined } {
  if (!MLPredictorService.isGradeReady()) {
    return { gradeShapValues: undefined, gradeFactors: undefined };
  }
  try {
    const { shapValues, factors } = explainGradeFactorsFromShap(
      features,
      (f) => MLPredictorService.predictGrade(f) ?? 0
    );
    return { gradeShapValues: shapValues, gradeFactors: factors };
  } catch (error) {
    console.warn("[ML] Grade SHAP computation failed:", error);
    return { gradeShapValues: undefined, gradeFactors: undefined };
  }
}

/**
 * Resolves the risk + grade explanations, preferring the real `shap` library
 * microservice and degrading gracefully to the in-process JS exact-Shapley
 * (or rule-based) explanation when the service is unavailable.
 */
export async function resolveRiskExplanation(features: PredictionFeatures): Promise<RiskExplanation> {
  const remote = await fetchShapFromService(features);
  if (remote) {
    // Older service builds don't return grade fields — fill them locally.
    const grade = remote.gradeShapValues ? { gradeShapValues: remote.gradeShapValues, gradeFactors: remote.gradeFactors } : buildGradeExplanation(features);
    return { riskFactors: remote.riskFactors, shapValues: remote.shapValues, ...grade, explainSource: "shap-python" };
  }
  return {
    riskFactors: buildRiskFactors(features),
    shapValues: buildShapValues(features),
    ...buildGradeExplanation(features),
    explainSource: MLPredictorService.isReady() ? "shap-js" : "rules"
  };
}
