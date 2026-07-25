/**
 * itemAnalysisClient.ts
 *
 * Thin client for the Python ML service's classical item-analysis endpoint
 * (`POST /item-analysis`). Node gathers each student's gradable per-question
 * responses (from User.progress.skillAttempts); Python computes difficulty +
 * discrimination + KR-20 reliability and flags problematic questions.
 */
import {
  SHAP_SERVICE_URL,
  SHAP_SERVICE_TIMEOUT_MS,
  markShapServiceUp,
  markShapServiceDown
} from "../prediction/explain";

export type ItemResponse = { questionIndex: number; correct: boolean; gradable: boolean };
export type ItemAttempt = { responses: ItemResponse[] };

export type ItemStat = {
  questionIndex: number;
  n: number;
  difficulty: number;
  discrimination: number | null;
  flag: "ok" | "too_easy" | "too_hard" | "weak" | "misleading" | "insufficient_data";
};

export type ItemAnalysisResult = {
  items: ItemStat[];
  summary: {
    nAttempts: number;
    nQuestions: number;
    meanDifficulty: number | null;
    reliabilityAlpha: number | null;
    flaggedCount: number;
  };
};

/** Runs item analysis for one quiz's attempts. Throws if the ML service is down. */
export async function computeItemAnalysis(attempts: ItemAttempt[]): Promise<ItemAnalysisResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHAP_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/item-analysis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attempts }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`ML service /item-analysis -> ${res.status}`);
    const data = (await res.json()) as ItemAnalysisResult;
    markShapServiceUp();
    return data;
  } catch (err) {
    markShapServiceDown();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
