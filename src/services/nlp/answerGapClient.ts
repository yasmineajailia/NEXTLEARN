/**
 * answerGapClient.ts
 *
 * Thin client for the Python ML service's `/nlp/answer-gap` endpoint (semantic
 * gap analysis). The student explains a lesson in their own words; Python
 * compares the text against the lesson's indexed content chunks (embeddings,
 * lexical fallback) and returns which key concepts are covered vs missing.
 */
import { SHAP_SERVICE_URL } from "../prediction/explain";

export type AnswerGapResult = {
  available: boolean;
  reason?: string; // when unavailable: "too-short" | "no-content"
  method?: "embedding" | "lexical";
  score?: number; // 0-100 concept coverage
  band?: "acquired" | "partial" | "gap";
  conceptCount?: number;
  covered?: string[];
  missing?: string[];
};

const ANSWER_GAP_TIMEOUT_MS = 30_000; // embeds a batch of sentences — slower than /mastery

export async function fetchAnswerGap(params: {
  moduleId: string;
  subAcquisId: string;
  text: string;
  lang?: "fr" | "en";
}): Promise<AnswerGapResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWER_GAP_TIMEOUT_MS);
  try {
    const res = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/nlp/answer-gap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleId: params.moduleId,
        subAcquisId: params.subAcquisId,
        text: params.text,
        lang: params.lang === "en" ? "en" : "fr"
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`ML service /nlp/answer-gap -> ${res.status}`);
    const data = (await res.json()) as Partial<AnswerGapResult>;
    return {
      available: Boolean(data.available),
      reason: typeof data.reason === "string" ? data.reason : undefined,
      method: data.method === "lexical" ? "lexical" : data.method === "embedding" ? "embedding" : undefined,
      score: typeof data.score === "number" ? data.score : undefined,
      band: data.band === "acquired" || data.band === "partial" || data.band === "gap" ? data.band : undefined,
      conceptCount: typeof data.conceptCount === "number" ? data.conceptCount : undefined,
      covered: Array.isArray(data.covered) ? data.covered.map(String) : [],
      missing: Array.isArray(data.missing) ? data.missing.map(String) : []
    };
  } finally {
    clearTimeout(timer);
  }
}
