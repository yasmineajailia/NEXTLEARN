/**
 * attentionClient.ts
 *
 * Teacher-dashboard attention ANALYTICS run in the Python ML service
 * (`POST /attention-analytics`). Only DERIVED metrics are sent — per-session
 * focus scores and distraction reason codes — never frames or landmarks. The
 * webcam model itself stays in the browser (privacy invariant); this only moves
 * the trend / top-distraction number-crunching off the Node process.
 */
import {
  SHAP_SERVICE_URL,
  SHAP_SERVICE_TIMEOUT_MS,
  markShapServiceUp,
  markShapServiceDown
} from "../prediction/explain";

export type AttentionAnalyticsInput = {
  /** Per-session focus scores in chronological order. */
  avgScores: number[];
  /** Flat list of distraction reason codes across the student's sessions. */
  distractions: string[];
};

export type AttentionAnalytics = {
  trend: "improving" | "declining" | "stable";
  topDistraction: string | null;
};

/** Batch analytics for a whole class in one call. Throws if the service is down. */
export async function computeAttentionAnalytics(
  students: AttentionAnalyticsInput[]
): Promise<AttentionAnalytics[]> {
  if (students.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHAP_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/attention-analytics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ students }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`ML service /attention-analytics -> ${res.status}`);
    const data = (await res.json()) as { results?: AttentionAnalytics[] };
    if (!Array.isArray(data.results) || data.results.length !== students.length) {
      throw new Error("malformed /attention-analytics payload");
    }
    markShapServiceUp();
    return data.results;
  } catch (err) {
    markShapServiceDown();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
