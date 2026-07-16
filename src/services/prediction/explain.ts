/**
 * Risk / grade prediction + explanation, served by the Python ML service
 * (ml/shap_service.py). One POST /explain returns the catch-up probability, the
 * predicted grade AND their exact SHAP attributions.
 *
 * There is no JS fallback: the service is auto-started and supervised
 * (shapSupervisor.ts), so unavailability is a genuine error surfaced to the
 * caller — not a silent degrade to rule-based numbers.
 */
import { type PredictionFeatures, type RiskFactor } from "./features";

export const SHAP_SERVICE_URL = process.env.SHAP_SERVICE_URL || "http://127.0.0.1:8000";
export const SHAP_SERVICE_TIMEOUT_MS = 4000;
export const SHAP_SERVICE_BACKOFF_MS = 30_000;
export let shapServiceDownUntil = 0;

/** Clears the circuit breaker — called once /health (or any call) succeeds. */
export function markShapServiceUp(): void {
  shapServiceDownUntil = 0;
}

/** Trips the circuit breaker so callers fast-fail (e.g. when the child dies). */
export function markShapServiceDown(ms: number = SHAP_SERVICE_BACKOFF_MS): void {
  shapServiceDownUntil = Date.now() + ms;
}

/** True while the service is within its backoff window. */
export function isShapServiceDown(): boolean {
  return Date.now() < shapServiceDownUntil;
}

export type RiskExplanation = {
  /** Probability in [0, 1] that the student catches up. */
  catchupProbability: number;
  /** Predicted exam grade on /20, or null when the grade model isn't served. */
  predictedGrade: number | null;
  riskFactors: RiskFactor[];
  shapValues: Record<string, number> | undefined;
  /** SHAP contributions to the predicted grade, in points /20. */
  gradeShapValues: Record<string, number> | undefined;
  /** Top drivers of the predicted grade (impacts in points /20). */
  gradeFactors: RiskFactor[] | undefined;
  /** Always the real shap library now; kept for API compatibility. */
  explainSource: "shap-python";
};

type ExplainPayload = {
  catchupProbability?: number;
  predictedGrade?: number | null;
  riskFactors?: RiskFactor[];
  shapValues?: Record<string, number>;
  gradeShapValues?: Record<string, number>;
  gradeFactors?: RiskFactor[];
};

/**
 * Resolves the risk + grade prediction and their SHAP explanation from the
 * Python service. Throws on any failure (no fallback).
 */
export async function resolveRiskExplanation(features: PredictionFeatures): Promise<RiskExplanation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHAP_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(features),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`ML service /explain -> ${res.status}`);
    const data = (await res.json()) as ExplainPayload;
    if (!Array.isArray(data.riskFactors) || typeof data.catchupProbability !== "number") {
      throw new Error("malformed /explain payload");
    }
    markShapServiceUp();
    return {
      catchupProbability: data.catchupProbability,
      predictedGrade: typeof data.predictedGrade === "number" ? data.predictedGrade : null,
      riskFactors: data.riskFactors,
      shapValues: data.shapValues,
      gradeShapValues: data.gradeShapValues,
      gradeFactors: Array.isArray(data.gradeFactors) ? data.gradeFactors : undefined,
      explainSource: "shap-python"
    };
  } catch (err) {
    markShapServiceDown();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
