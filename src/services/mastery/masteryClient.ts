/**
 * masteryClient.ts
 *
 * Thin client for the Python ML service's `/mastery` endpoint (the SAKT
 * knowledge-tracing model + prerequisite-graph smoothing). Node owns the student
 * data (attempt history, curriculum) and passes it in; Python returns the
 * per-skill mastery, which the recommendation layer then consumes.
 */
import { SHAP_SERVICE_URL } from "../prediction/explain";

export type MasteryInteraction = { skillId: string; correct: boolean };

export type MasteryEntry = { mastery: number; rawMastery?: number; source: string };

export type MasteryResponse = {
  available: boolean;
  testAuc: number;
  graphApplied: boolean;
  mastery: Record<string, MasteryEntry>;
  revisionOrder?: Array<{ skillId: string; mastery: number; blockedBy: string[] }>;
};

const MASTERY_TIMEOUT_MS = 15_000;

export async function fetchMastery(params: {
  history: MasteryInteraction[];
  targetSkillIds: string[];
  applyGraph?: boolean;
}): Promise<MasteryResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MASTERY_TIMEOUT_MS);
  try {
    const res = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/mastery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history: params.history,
        targetSkillIds: params.targetSkillIds,
        applyGraph: params.applyGraph !== false
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`ML service /mastery -> ${res.status}`);
    const data = (await res.json()) as Partial<MasteryResponse>;
    return {
      available: Boolean(data.available),
      testAuc: Number(data.testAuc || 0),
      graphApplied: Boolean(data.graphApplied),
      mastery: (data.mastery as Record<string, MasteryEntry>) || {},
      revisionOrder: Array.isArray(data.revisionOrder) ? data.revisionOrder : []
    };
  } finally {
    clearTimeout(timer);
  }
}
