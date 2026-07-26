/**
 * ragClient.ts
 *
 * The student chatbot's RAG serving now lives entirely in the Python ML service
 * (retrieval over ChromaDB + scope guards + LLM generation, buffered and
 * streamed). This is the sole client: Node owns access control + curriculum and
 * passes the allowed module/sub-acquis ids; Python does everything else. There
 * is no JS engine or JS fallback anymore.
 *
 * No circuit-breaker coupling — a slow LLM call must not mark the fast ML
 * endpoints (predict/explain) down.
 */
import { SHAP_SERVICE_URL } from "../prediction/explain";
import { env } from "../../config/env";
import { normalizeWhitespace } from "../textNormalize";
import type { LearnerProfile } from "./learnerProfile";

export type StudentChatTurn = { role: "user" | "assistant"; content: string };

/**
 * Normalizes a raw `history` payload from the client into a bounded, safe list
 * of prior conversation turns for conversation-memory-aware answers.
 */
export function normalizeChatHistory(raw: unknown, maxTurns = 6): StudentChatTurn[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(
      (entry): entry is StudentChatTurn =>
        !!entry &&
        typeof entry === "object" &&
        (entry as { role?: unknown }).role !== undefined &&
        typeof (entry as { content?: unknown }).content === "string" &&
        ((entry as { role?: unknown }).role === "user" || (entry as { role?: unknown }).role === "assistant")
    )
    .map((entry) => ({ role: entry.role, content: normalizeWhitespace(String(entry.content)).slice(0, 1500) }))
    .filter((entry) => entry.content.length > 0)
    .slice(-maxTurns);
}

export type RagAnswerResult = {
  answer: string;
  mode: string;
  retrieved: number;
  sources: Array<{
    moduleId: string;
    moduleName: string;
    subAcquisId: string | null;
    subAcquisName: string | null;
    kind: string;
    excerpt: string;
  }>;
};

const RAG_ANSWER_TIMEOUT_MS = 60_000;

function serviceUrl(path: string): string {
  return `${SHAP_SERVICE_URL.replace(/\/$/, "")}${path}`;
}

export async function answerViaPython(params: {
  question: string;
  allowedModuleIds: string[];
  allowedSubAcquisIds: string[];
  filterToModuleId?: string;
  filterToSubAcquisId?: string;
  history: StudentChatTurn[];
  lang: "fr" | "en";
  learnerProfile?: LearnerProfile;
}): Promise<RagAnswerResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RAG_ANSWER_TIMEOUT_MS);
  try {
    const res = await fetch(serviceUrl("/rag/answer"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`ML service /rag/answer -> ${res.status}`);
    const data = (await res.json()) as Partial<RagAnswerResult>;
    return {
      answer: String(data.answer || ""),
      mode: String(data.mode || "python"),
      retrieved: Number(data.retrieved || 0),
      sources: Array.isArray(data.sources) ? data.sources : []
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming variant: opens the Python `/rag/stream` SSE endpoint and pipes each
 * upstream text chunk to `onChunk` verbatim. Python already emits proper
 * `event:/data:` frames (meta/delta/sources/done), so Node forwards them as-is;
 * the browser contract is unchanged. Throws before the first byte if the upstream
 * request fails, so the caller can surface an error frame.
 */
export async function streamViaPython(
  params: {
    question: string;
    allowedModuleIds: string[];
    allowedSubAcquisIds: string[];
    filterToModuleId?: string;
    filterToSubAcquisId?: string;
    history: StudentChatTurn[];
    lang: "fr" | "en";
    learnerProfile?: LearnerProfile;
  },
  onChunk: (text: string) => void
): Promise<void> {
  const res = await fetch(serviceUrl("/rag/stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });
  if (!res.ok || !res.body) {
    throw new Error(`ML service /rag/stream -> ${res.status}`);
  }
  const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

/**
 * Fire-and-forget: ask the Python service to (re)build the ChromaDB index from
 * the persisted curriculum. Called after a curriculum save so chatbot answers
 * pick up content edits, mirroring the old JS vector-store invalidation. The
 * reindex dedups on chunk id, so unchanged content is not re-embedded. Never
 * throws into the caller — a failed/here-not-yet Python service just logs.
 */
export function requestPythonReindex(modules: unknown[]): void {
  fetch(serviceUrl("/rag/reindex"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modules, baseUrl: env.appBaseUrl })
  }).catch((error) => {
    console.warn("[rag] Python reindex trigger failed:", error instanceof Error ? error.message : error);
  });
}
