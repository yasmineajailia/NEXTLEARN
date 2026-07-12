/**
 * LLM provider plumbing (OpenRouter/OpenAI-compatible + Gemini): embeddings,
 * model catalog resolution, and response-shape normalization. Shared by the
 * student chatbot and the teacher quiz generation.
 */
import { env } from "../config/env";

export function hasEmbeddingProvider(): boolean {
  return Boolean(env.geminiApiKey || env.openaiApiKey);
}

export async function fetchOpenAiEmbeddings(texts: string[]): Promise<number[][]> {
  if (!env.openaiApiKey) {
    throw new Error("OpenAI embeddings are not configured");
  }

  const response = await fetch(`${env.openaiEmbeddingBaseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.openaiEmbeddingModel,
      input: texts
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Embedding request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
  };

  const ordered = Array.isArray(payload.data)
    ? payload.data
        .map((item, index) => ({
          index: typeof item.index === "number" ? item.index : index,
          embedding: Array.isArray(item.embedding) ? item.embedding : []
        }))
        .sort((left, right) => left.index - right.index)
        .map((item) => item.embedding)
    : [];

  if (ordered.length !== texts.length) {
    throw new Error("Embedding response size mismatch");
  }

  return ordered;
}

export async function fetchGeminiEmbeddings(texts: string[]): Promise<number[][]> {
  if (!env.geminiApiKey) {
    throw new Error("Gemini embeddings are not configured");
  }

  const embeddingModelName = await resolveGeminiModelForMethod(
    "embedContent",
    env.geminiEmbeddingModel,
    ["text-embedding-004", "embedding-001"]
  );

  const embeddings: number[][] = [];
  for (const text of texts) {
    const response = await fetch(
      `${env.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(embeddingModelName)}:embedContent?key=${encodeURIComponent(env.geminiApiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: {
            parts: [{ text }]
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Gemini embedding request failed (${response.status}): ${errorText}`);
    }

    const payload = (await response.json()) as {
      embedding?: {
        values?: number[];
      };
    };

    embeddings.push(Array.isArray(payload.embedding?.values) ? payload.embedding.values : []);
  }

  return embeddings;
}

export type GeminiModelEntry = {
  name?: string;
  supportedGenerationMethods?: string[];
};

export let geminiModelCatalogCache: GeminiModelEntry[] | null = null;

export function normalizeGeminiModelName(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^models\//i, "");
}

export async function listGeminiModels(): Promise<GeminiModelEntry[]> {
  if (!env.geminiApiKey) {
    return [];
  }

  if (geminiModelCatalogCache) {
    return geminiModelCatalogCache;
  }

  const response = await fetch(
    `${env.geminiBaseUrl.replace(/\/$/, "")}/models?key=${encodeURIComponent(env.geminiApiKey)}`,
    {
      method: "GET"
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Gemini ListModels failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    models?: GeminiModelEntry[];
  };

  geminiModelCatalogCache = Array.isArray(payload.models) ? payload.models : [];
  return geminiModelCatalogCache;
}

export async function resolveGeminiModelForMethod(
  method: "generateContent" | "embedContent",
  preferredModel: string,
  fallbackCandidates: string[]
): Promise<string> {
  const models = await listGeminiModels();
  const supportsMethod = (entry: GeminiModelEntry): boolean =>
    Array.isArray(entry.supportedGenerationMethods) && entry.supportedGenerationMethods.includes(method);
  const modelSet = new Set(
    models
      .filter((entry) => supportsMethod(entry) && typeof entry.name === "string")
      .map((entry) => normalizeGeminiModelName(String(entry.name || "")))
      .filter(Boolean)
  );

  const normalizedPreferred = normalizeGeminiModelName(preferredModel);
  if (normalizedPreferred && modelSet.has(normalizedPreferred)) {
    return normalizedPreferred;
  }

  for (const candidate of fallbackCandidates) {
    const normalizedCandidate = normalizeGeminiModelName(candidate);
    if (modelSet.has(normalizedCandidate)) {
      return normalizedCandidate;
    }
  }

  const firstCompatible = models.find((entry) => {
    if (!supportsMethod(entry) || typeof entry.name !== "string") {
      return false;
    }

    const normalized = normalizeGeminiModelName(entry.name);
    return method === "embedContent"
      ? normalized.includes("embed") || normalized.includes("embedding")
      : normalized.includes("gemini");
  });

  if (firstCompatible?.name) {
    return normalizeGeminiModelName(firstCompatible.name);
  }

  throw new Error(`No Gemini model supports ${method} in the current account/API version.`);
}

export async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  if (env.geminiApiKey) {
    return fetchGeminiEmbeddings(texts);
  }

  return fetchOpenAiEmbeddings(texts);
}

// Rebuilding/verifying the whole vector store (which parses every course PDF
// to hash its content) is expensive, so it must not run on every chatbot
// request. We cache the "ready" result for a TTL and de-duplicate concurrent
// rebuilds so at most one runs at a time. Content edits are picked up on the
// next rebuild after the TTL expires (or immediately via invalidateStudentVectorStore).

export function extractAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}
