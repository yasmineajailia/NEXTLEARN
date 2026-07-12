/**
 * Student chatbot RAG engine.
 *
 * Builds a retrieval index over the curriculum (module names, sub-acquis,
 * extracted course-file text), stores embeddings in StudentChatbotVector when
 * an embedding provider is configured (vector mode) and falls back to lexical
 * scoring otherwise, then answers questions strictly from the retrieved
 * context (deterministic fallback answer + LLM generation/streaming).
 *
 * Everything here takes the persisted curriculum as parameters — reading it
 * is the caller's job (see routes/student/chatbot.ts).
 */
import { createHash } from "node:crypto";
import { env } from "../../config/env";
import { StudentChatbotVector } from "../../models/StudentChatbotVector";
import type { CurriculumModuleDoc, ModuleOverview } from "../../types/curriculum";
import {
  extractAssistantText,
  fetchEmbeddings,
  hasEmbeddingProvider,
  resolveGeminiModelForMethod
} from "../llm";
import { extractCourseContentSnippetsFromUrl } from "../courseContent";
import { normalizeForLookup, normalizeWhitespace } from "../textNormalize";
import { moduleDocToOverview } from "../curriculum";


export type StudentRagChunk = {
  moduleId: string;
  moduleName: string;
  subAcquisId: string | null;
  subAcquisName: string | null;
  kind: "module" | "sub-acquis" | "quiz" | "video" | "course-file" | "course-content";
  text: string;
  tokens: string[];
};

export type StudentVectorChunk = StudentRagChunk & {
  chunkId: string;
  contentHash: string;
  embedding?: number[];
};

export function hashStudentVectorText(value: string): string {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function buildStudentVectorChunkId(chunk: StudentRagChunk): string {
  const subKey = chunk.subAcquisId || "module";
  return hashStudentVectorText(`${chunk.moduleId}|${subKey}|${chunk.kind}|${chunk.text}`);
}

export function normalizeVector(values: number[]): number[] {
  const sumSquares = values.reduce((sum, value) => sum + value * value, 0);
  const magnitude = Math.sqrt(sumSquares);
  if (!magnitude) {
    return values;
  }

  return values.map((value) => value / magnitude);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (!length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] || 0;
    const rightValue = right[index] || 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export const STUDENT_VECTOR_STORE_TTL_MS = 10 * 60 * 1000;
export let studentVectorStoreReady: { at: number; value: boolean } | null = null;
export let studentVectorStoreInFlight: Promise<boolean> | null = null;

/** Marks the vector store as stale so the next request rebuilds it (call after curriculum edits). */
export function invalidateStudentVectorStore(): void {
  studentVectorStoreReady = null;
}

export async function ensureStudentVectorStore(persistedModules: CurriculumModuleDoc[]): Promise<boolean> {
  if (!hasEmbeddingProvider()) {
    return false;
  }

  const now = Date.now();
  if (studentVectorStoreReady && now - studentVectorStoreReady.at < STUDENT_VECTOR_STORE_TTL_MS) {
    return studentVectorStoreReady.value;
  }

  if (studentVectorStoreInFlight) {
    return studentVectorStoreInFlight;
  }

  studentVectorStoreInFlight = (async () => {
    try {
      const value = await rebuildStudentVectorStore(persistedModules);
      studentVectorStoreReady = { at: Date.now(), value };
      return value;
    } catch (error) {
      console.warn("Student vector store rebuild failed:", error);
      // Cache the failure briefly so we don't hammer the embedding API on every request.
      studentVectorStoreReady = { at: Date.now(), value: false };
      return false;
    } finally {
      studentVectorStoreInFlight = null;
    }
  })();

  return studentVectorStoreInFlight;
}

export async function rebuildStudentVectorStore(persistedModules: CurriculumModuleDoc[]): Promise<boolean> {
  if (!hasEmbeddingProvider()) {
    return false;
  }

  const corpus = (await buildStudentRagIndex({
    accessibleOverview: persistedModules.map(moduleDocToOverview),
    persistedModules
  })).map((chunk) => ({
    ...chunk,
    chunkId: buildStudentVectorChunkId(chunk),
    contentHash: hashStudentVectorText(chunk.text)
  }));

  const chunkIds = corpus.map((chunk) => chunk.chunkId);
  const existing = await StudentChatbotVector.find({ chunkId: { $in: chunkIds } })
    .select({ chunkId: 1, contentHash: 1 })
    .lean();
  const existingMap = new Map(existing.map((entry) => [String(entry.chunkId), String(entry.contentHash)]));

  const chunksToEmbed = corpus.filter((chunk) => existingMap.get(chunk.chunkId) !== chunk.contentHash);
  const batchSize = 32;

  for (let index = 0; index < chunksToEmbed.length; index += batchSize) {
    const batch = chunksToEmbed.slice(index, index + batchSize);
    const embeddings = await fetchEmbeddings(batch.map((chunk) => chunk.text));

    const operations = batch.map((chunk, batchIndex) => ({
      updateOne: {
        filter: { chunkId: chunk.chunkId },
        update: {
          $set: {
            chunkId: chunk.chunkId,
            moduleId: chunk.moduleId,
            moduleName: chunk.moduleName,
            subAcquisId: chunk.subAcquisId,
            subAcquisName: chunk.subAcquisName,
            kind: chunk.kind,
            text: chunk.text,
            contentHash: chunk.contentHash,
            embedding: normalizeVector(embeddings[batchIndex] || [])
          }
        },
        upsert: true
      }
    }));

    if (operations.length) {
      await StudentChatbotVector.bulkWrite(operations);
    }
  }

  const storedChunkIds = new Set(chunkIds);
  if (storedChunkIds.size) {
    await StudentChatbotVector.deleteMany({ chunkId: { $nin: chunkIds } });
  }

  return true;
}

export async function getStudentVectorMatches(params: {
  persistedModules: CurriculumModuleDoc[];
  accessibleOverview: ModuleOverview[];
  question: string;
  filterToModuleId?: string;
  filterToSubAcquisId?: string;
}): Promise<StudentRagChunk[]> {
  const { persistedModules, accessibleOverview, question, filterToModuleId, filterToSubAcquisId } = params;
  let allowedModuleIds = new Set(accessibleOverview.map((entry) => entry.id));
  let allowedSubAcquisIds = new Set(
    accessibleOverview.flatMap((entry) => entry.subAcquis.map((sub) => `${entry.id}::${sub.id}`))
  );

  // Narrow to a specific module when provided.
  if (filterToModuleId) {
    allowedModuleIds = new Set([filterToModuleId]);
    allowedSubAcquisIds = new Set(
      [...allowedSubAcquisIds].filter((entry) => entry.startsWith(`${filterToModuleId}::`))
    );
  }

  // We intentionally keep the whole MODULE in scope even when a current
  // sub-acquis is provided: the answer to a question (e.g. "quand utiliser
  // if else" while on the comparison lesson) often lives in a sibling
  // sub-acquis. The current sub-acquis is *boosted* rather than isolated.
  const boostSubAcquisId = filterToSubAcquisId ? filterToSubAcquisId : null;

  const fallbackToLegacy = async () => {
    const ragIndex = (await buildStudentRagIndex({ accessibleOverview, persistedModules })).filter((chunk) => {
      if (!allowedModuleIds.has(chunk.moduleId)) {
        return false;
      }

      if (!chunk.subAcquisId) {
        return true;
      }

      return allowedSubAcquisIds.has(`${chunk.moduleId}::${chunk.subAcquisId}`);
    });
    const queryNormalized = normalizeForLookup(question);
    const queryTokens = tokenizeForStudentRag(question);

    return ragIndex
      .map((chunk) => {
        let score = scoreStudentRagChunk(chunk, queryNormalized, queryTokens);
        // Gentle tiebreaker toward the lesson the student is currently on,
        // without preventing a more relevant sibling chunk from winning.
        if (boostSubAcquisId && chunk.subAcquisId === boostSubAcquisId) {
          score *= 1.15;
        }
        return { chunk, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((entry) => entry.chunk);
  };

  // With a current sub-acquis (the sous-acquis chatbot), lexical ranking over
  // the whole module is fast and good — and skips the embedding round-trip.
  if (filterToModuleId && filterToSubAcquisId) {
    return fallbackToLegacy();
  }

  try {
    const vectorStoreReady = await ensureStudentVectorStore(persistedModules);

    if (!vectorStoreReady) {
      return fallbackToLegacy();
    }

    const queryEmbedding = normalizeVector((await fetchEmbeddings([question]))[0] || []);
    const docs = await StudentChatbotVector.find({ moduleId: { $in: [...allowedModuleIds] } }).lean();

    const ranked = docs
      .map((doc) => ({
        doc,
        score:
          (doc.subAcquisId ? allowedSubAcquisIds.has(`${doc.moduleId}::${doc.subAcquisId}`) : true)
            ? cosineSimilarity(queryEmbedding, normalizeVector(Array.isArray(doc.embedding) ? doc.embedding : []))
            : 0
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    return ranked.map(({ doc }) => ({
      moduleId: String(doc.moduleId),
      moduleName: String(doc.moduleName || doc.moduleId),
      subAcquisId: doc.subAcquisId ? String(doc.subAcquisId) : null,
      subAcquisName: doc.subAcquisName ? String(doc.subAcquisName) : null,
      kind: doc.kind,
      text: String(doc.text || ""),
      tokens: tokenizeForStudentRag(String(doc.text || ""))
    }));
  } catch (error) {
    console.warn("Vector chatbot retrieval failed; using legacy retrieval fallback:", error);
    return fallbackToLegacy();
  }
}

export async function evaluateQuestionAgainstScopedModule(params: {
  persistedModules: CurriculumModuleDoc[];
  accessibleOverview: ModuleOverview[];
  question: string;
  targetModuleId: string;
}): Promise<{
  usedEmbeddings: boolean;
  accepted: boolean;
  targetScore: number;
  topModuleId: string | null;
  topScore: number;
}> {
  const { persistedModules, accessibleOverview, question, targetModuleId } = params;

  if (!hasEmbeddingProvider()) {
    return {
      usedEmbeddings: false,
      accepted: true,
      targetScore: 0,
      topModuleId: null,
      topScore: 0
    };
  }

  try {
    const vectorStoreReady = await ensureStudentVectorStore(persistedModules);
    if (!vectorStoreReady) {
      return {
        usedEmbeddings: false,
        accepted: true,
        targetScore: 0,
        topModuleId: null,
        topScore: 0
      };
    }

    const allowedModuleIds = accessibleOverview.map((entry) => entry.id);
    const docs = await StudentChatbotVector.find({ moduleId: { $in: allowedModuleIds } }).lean();
    const queryEmbedding = normalizeVector((await fetchEmbeddings([question]))[0] || []);

    const moduleBestScore = new Map<string, number>();
    for (const doc of docs) {
      const moduleId = String(doc.moduleId || "");
      if (!moduleId) {
        continue;
      }

      const score = cosineSimilarity(queryEmbedding, normalizeVector(Array.isArray(doc.embedding) ? doc.embedding : []));
      const currentBest = moduleBestScore.get(moduleId) || 0;
      if (score > currentBest) {
        moduleBestScore.set(moduleId, score);
      }
    }

    let topModuleId: string | null = null;
    let topScore = 0;
    for (const [moduleId, score] of moduleBestScore.entries()) {
      if (score > topScore) {
        topScore = score;
        topModuleId = moduleId;
      }
    }

    const targetScore = moduleBestScore.get(targetModuleId) || 0;

    // Hard floor + relative comparison with the best matching module.
    const minAbsoluteScore = 0.2;
    const minRelativeToTop = 0.85;
    const accepted =
      targetScore >= minAbsoluteScore &&
      (topScore <= 0 || targetModuleId === topModuleId || targetScore >= topScore * minRelativeToTop);

    return {
      usedEmbeddings: true,
      accepted,
      targetScore,
      topModuleId,
      topScore
    };
  } catch (error) {
    console.warn("Embedding scope-evaluation failed; falling back to lexical guard:", error);
    return {
      usedEmbeddings: false,
      accepted: true,
      targetScore: 0,
      topModuleId: null,
      topScore: 0
    };
  }
}

export function tokenizeForStudentRag(value: string): string[] {
  const stopwords = new Set([
    "le",
    "la",
    "les",
    "de",
    "des",
    "du",
    "un",
    "une",
    "et",
    "ou",
    "dans",
    "sur",
    "pour",
    "avec",
    "que",
    "qui",
    "quoi",
    "est",
    "sous",
    "acquis",
    "module"
  ]);

  const normalized = normalizeForLookup(String(value || ""));
  return normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopwords.has(token));
}

export async function buildStudentRagIndex(params: {
  accessibleOverview: ModuleOverview[];
  persistedModules: CurriculumModuleDoc[];
}): Promise<StudentRagChunk[]> {
  const { accessibleOverview, persistedModules } = params;
  const allowedModuleIds = new Set(accessibleOverview.map((entry) => entry.id));
  const allowedSubAcquisIds = new Set(
    accessibleOverview.flatMap((entry) => entry.subAcquis.map((sub) => `${entry.id}::${sub.id}`))
  );

  const chunks: StudentRagChunk[] = [];
  for (const moduleData of accessibleOverview) {
    const moduleText = `Module ${moduleData.id}: ${moduleData.name}`;
    chunks.push({
      moduleId: moduleData.id,
      moduleName: moduleData.name,
      subAcquisId: null,
      subAcquisName: null,
      kind: "module",
      text: moduleText,
      tokens: tokenizeForStudentRag(moduleText)
    });
  }

  for (const moduleDoc of persistedModules) {
    if (!allowedModuleIds.has(moduleDoc.id)) {
      continue;
    }

    const moduleName = String(moduleDoc.name || moduleDoc.id);
    const subAcquisList = (Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : []).flatMap((acquis) =>
      Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : []
    );

    for (const subAcquis of subAcquisList) {
      const accessKey = `${moduleDoc.id}::${subAcquis.id}`;
      if (!allowedSubAcquisIds.has(accessKey)) {
        continue;
      }

      const subName = String(subAcquis.name || subAcquis.id);
      const header = `${moduleDoc.id}.${subAcquis.id} ${moduleName} ${subName}`;
      chunks.push({
        moduleId: moduleDoc.id,
        moduleName,
        subAcquisId: subAcquis.id,
        subAcquisName: subName,
        kind: "sub-acquis",
        text: header,
        tokens: tokenizeForStudentRag(header)
      });

      const quizPrompts = (Array.isArray(subAcquis.quizzes) ? subAcquis.quizzes : []).flatMap((quiz) =>
        Array.isArray(quiz.questions) ? quiz.questions.map((question) => question.prompt).filter(Boolean) : []
      );
      for (const prompt of quizPrompts.slice(0, 4)) {
        const quizText = `Quiz ${subAcquis.id}: ${String(prompt || "").trim()}`;
        chunks.push({
          moduleId: moduleDoc.id,
          moduleName,
          subAcquisId: subAcquis.id,
          subAcquisName: subName,
          kind: "quiz",
          text: quizText,
          tokens: tokenizeForStudentRag(quizText)
        });
      }

      const videos = Array.isArray(subAcquis.videos) ? subAcquis.videos : [];
      for (const video of videos.slice(0, 3)) {
        const videoText = `Video ${subAcquis.id}: ${String(video.title || "").trim()}`;
        chunks.push({
          moduleId: moduleDoc.id,
          moduleName,
          subAcquisId: subAcquis.id,
          subAcquisName: subName,
          kind: "video",
          text: videoText,
          tokens: tokenizeForStudentRag(videoText)
        });
      }

      const courseFiles = Array.isArray(subAcquis.courseFiles) ? subAcquis.courseFiles : [];
      for (const file of courseFiles.slice(0, 5)) {
        const fileText = `Support ${subAcquis.id}: ${String(file.title || file.id || "").trim()}`;
        chunks.push({
          moduleId: moduleDoc.id,
          moduleName,
          subAcquisId: subAcquis.id,
          subAcquisName: subName,
          kind: "course-file",
          text: fileText,
          tokens: tokenizeForStudentRag(fileText)
        });

        const snippets = await extractCourseContentSnippetsFromUrl(String(file.url || ""));
        for (const snippet of snippets.slice(0, 8)) {
          const contentText = `Contenu support ${subAcquis.id} (${String(file.title || file.id || "support").trim()}): ${snippet}`;
          chunks.push({
            moduleId: moduleDoc.id,
            moduleName,
            subAcquisId: subAcquis.id,
            subAcquisName: subName,
            kind: "course-content",
            text: contentText,
            tokens: tokenizeForStudentRag(contentText)
          });
        }
      }
    }
  }

  return chunks;
}

export function scoreStudentRagChunk(chunk: StudentRagChunk, query: string, queryTokens: string[]): number {
  if (!queryTokens.length) {
    return 0;
  }

  const chunkTokenSet = new Set(chunk.tokens);
  let overlap = 0;
  for (const token of queryTokens) {
    if (chunkTokenSet.has(token)) {
      overlap += 1;
    }
  }

  if (overlap === 0) {
    return 0;
  }

  const exactLikeBoost = normalizeForLookup(chunk.text).includes(query) ? 2 : 0;
  const kindWeight =
    chunk.kind === "sub-acquis" ? 1.6 :
    chunk.kind === "course-content" ? 1.5 :
    chunk.kind === "quiz" ? 1.4 :
    chunk.kind === "module" ? 1.2 : 1.0;

  const coverage = overlap / Math.max(1, queryTokens.length);
  return coverage * 8 * kindWeight + overlap + exactLikeBoost;
}

export function refineStudentRagChunks(question: string, chunks: StudentRagChunk[]): StudentRagChunk[] {
  if (!chunks.length) {
    return [];
  }

  const normalized = normalizeForLookup(question);
  const asksQuiz =
    normalized.includes("quiz") ||
    normalized.includes("question") ||
    normalized.includes("qcm") ||
    normalized.includes("exercice");
  const asksVideo = normalized.includes("video") || normalized.includes("vidéo");

  // For conceptual questions, prioritize course structure chunks over quiz noise.
  const preferredKinds = new Set<StudentRagChunk["kind"]>(
    asksQuiz
      ? ["quiz", "course-content", "sub-acquis", "module", "course-file", "video"]
      : asksVideo
        ? ["video", "course-content", "sub-acquis", "module", "course-file", "quiz"]
        : ["course-content", "sub-acquis", "module", "course-file", "video", "quiz"]
  );

  const byPreference = [...chunks].sort((a, b) => {
    const aRank = Array.from(preferredKinds).indexOf(a.kind);
    const bRank = Array.from(preferredKinds).indexOf(b.kind);
    return aRank - bRank;
  });

  const seen = new Set<string>();
  const refined: StudentRagChunk[] = [];

  for (const chunk of byPreference) {
    const key = chunk.subAcquisId
      ? `${chunk.moduleId}::${chunk.subAcquisId}`
      : `${chunk.moduleId}::module`;
    if (seen.has(key)) {
      continue;
    }

    // Unless explicitly asked, avoid listing many quiz chunks in final response context.
    if (!asksQuiz && chunk.kind === "quiz") {
      continue;
    }

    refined.push(chunk);
    seen.add(key);
    if (refined.length >= 5) {
      break;
    }
  }

  if (!refined.length) {
    return chunks.slice(0, 5);
  }

  return refined;
}

export function hasMeaningfulGroundingInChunks(question: string, chunks: StudentRagChunk[]): boolean {
  if (!chunks.length) {
    return false;
  }

  const questionTokens = tokenizeForStudentRag(question);
  if (!questionTokens.length) {
    return false;
  }

  const uniqueQuestionTokens = new Set(questionTokens);
  let maxOverlap = 0;

  for (const chunk of chunks) {
    const chunkTokenSet = new Set(chunk.tokens);
    let overlap = 0;

    for (const token of uniqueQuestionTokens) {
      if (chunkTokenSet.has(token)) {
        overlap += 1;
      }
    }

    if (overlap > maxOverlap) {
      maxOverlap = overlap;
    }
  }

  const coverage = maxOverlap / Math.max(1, uniqueQuestionTokens.size);
  return maxOverlap >= 2 || coverage >= 0.35;
}

export function isQuestionOutsideLangageC(question: string): boolean {
  const normalized = normalizeForLookup(question);
  const mentionsOtherLanguage =
    normalized.includes("python") ||
    normalized.includes("javascript") ||
    normalized.includes("java") ||
    normalized.includes("php") ||
    normalized.includes("ruby") ||
    normalized.includes("c++") ||
    normalized.includes("csharp") ||
    normalized.includes("c#");

  if (!mentionsOtherLanguage) {
    return false;
  }

  return !normalized.includes("langage c") && !normalized.includes(" en c") && !normalized.includes(" langage c ");
}

export function isAmbiguousProgrammingQuestion(question: string): boolean {
  const normalized = normalizeForLookup(question);
  const asksCodingPattern =
    normalized.includes("boucle") ||
    normalized.includes("for") ||
    normalized.includes("while") ||
    normalized.includes("if") ||
    normalized.includes("fonction") ||
    normalized.includes("variable");

  if (!asksCodingPattern) {
    return false;
  }

  // If the learner asks a generic coding question without grounding to C or the module,
  // prefer a scoped refusal to avoid cross-language answers.
  const explicitlyScopedToC =
    normalized.includes("langage c") || normalized.includes(" en c") || normalized.includes("module");

  return !explicitlyScopedToC;
}

export function buildStudentRagAnswer(question: string, topChunks: StudentRagChunk[]): string {
  const cleanQuestion = String(question || "").trim();
  if (!topChunks.length) {
    return "Je n'ai pas trouvé de contexte pertinent dans vos modules disponibles. Essayez avec un identifiant de module (ex: 4) ou de sous-acquis (ex: 4.3).";
  }

  const dedupSources = new Set<string>();
  const lines: string[] = [];
  for (const chunk of topChunks) {
    const source = chunk.subAcquisId
      ? `${chunk.moduleId}.${chunk.subAcquisId} - ${chunk.subAcquisName || "Sous-acquis"}`
      : `Module ${chunk.moduleId} - ${chunk.moduleName}`;

    if (!dedupSources.has(source)) {
      lines.push(`- ${source}`);
      dedupSources.add(source);
    }
  }

  const primary = topChunks[0];
  const primaryScope = primary.subAcquisName || primary.moduleName || "le contenu du module";
  const evidence = topChunks
    .slice(0, 3)
    .map((chunk) => {
      const label = chunk.subAcquisId
        ? `${chunk.moduleId}.${chunk.subAcquisId}`
        : `module ${chunk.moduleId}`;
      const excerpt = normalizeWhitespace(String(chunk.text || "")).slice(0, 240);
      return `- ${label}: ${excerpt}${excerpt.length >= 240 ? "..." : ""}`;
    })
    .filter(Boolean);

  return [
    `Pour répondre à votre question: ${cleanQuestion}`,
    `Point principal dans le module: ${primaryScope}.`,
    "Éléments trouvés dans le module:",
    ...evidence,
    "Si vous voulez, je peux détailler pas à pas à partir de ces éléments uniquement."
  ].join("\n");
}

export function isRefusalLikeAnswer(answer: string): boolean {
  const normalized = normalizeForLookup(answer);
  return (
    normalized.includes("je ne peux pas") ||
    normalized.includes("je ne peux pas fournir") ||
    normalized.includes("je ne peux pas vous aider") ||
    normalized.includes("je ne peux pas repondre") ||
    normalized.includes("pas fournir d'informations") ||
    normalized.includes("hors contexte")
  );
}

export function isAnswerGroundedInChunks(answer: string, chunks: StudentRagChunk[]): boolean {
  const normalizedAnswer = normalizeForLookup(answer);
  if (!normalizedAnswer || !chunks.length) {
    return false;
  }

  let matches = 0;
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const candidates = [
      String(chunk.subAcquisName || "").trim(),
      String(chunk.moduleName || "").trim(),
      chunk.subAcquisId ? `${chunk.moduleId}.${chunk.subAcquisId}` : `module ${chunk.moduleId}`
    ]
      .map((entry) => normalizeForLookup(entry))
      .filter((entry) => entry.length >= 3);

    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }

      if (normalizedAnswer.includes(candidate)) {
        seen.add(candidate);
        matches += 1;
      }
    }

    if (matches >= 1) {
      return true;
    }
  }

  // Content-overlap fallback: a natural answer that doesn't literally name the
  // sub-acquis is still grounded if most of its meaningful words come from the
  // retrieved chunk texts. This lets the model answer conversationally instead
  // of being forced to echo lesson titles.
  const chunkVocab = new Set<string>();
  for (const chunk of chunks) {
    for (const token of tokenizeForStudentRag(String(chunk.text || ""))) {
      chunkVocab.add(token);
    }
  }
  if (!chunkVocab.size) {
    return false;
  }

  const answerTokens = tokenizeForStudentRag(answer).filter((token) => token.length >= 4);
  if (answerTokens.length < 3) {
    return false;
  }

  let overlap = 0;
  for (const token of answerTokens) {
    if (chunkVocab.has(token)) {
      overlap += 1;
    }
  }

  return overlap >= 4 || overlap / answerTokens.length >= 0.35;
}

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
        (entry as any).role &&
        typeof (entry as any).content === "string" &&
        ((entry as any).role === "user" || (entry as any).role === "assistant")
    )
    .map((entry) => ({ role: entry.role, content: normalizeWhitespace(String(entry.content)).slice(0, 1500) }))
    .filter((entry) => entry.content.length > 0)
    .slice(-maxTurns);
}

/** Builds the shared system + user prompts used by both the buffered and streaming chat paths. */
export function buildStudentChatPrompts(
  question: string,
  topChunks: StudentRagChunk[],
  lang: "fr" | "en" = "fr"
): { systemPrompt: string; userPrompt: string } {
  const context = topChunks
    .slice(0, 6)
    .map((chunk, index) => {
      const label = chunk.subAcquisId
        ? `${chunk.moduleId}.${chunk.subAcquisId} - ${chunk.subAcquisName || "Sous-acquis"}`
        : `Module ${chunk.moduleId} - ${chunk.moduleName}`;
      return `${index + 1}. [${label}] (${chunk.kind}) ${chunk.text}`;
    })
    .join("\n");

  const systemPrompt = [
    "Tu es l'assistant pédagogique NextLearn qui aide des étudiants à comprendre le cours de programmation en C. Ton ton est clair, pédagogique et encourageant.",
    "",
    "Règles de contenu (strictes) :",
    "- Utilise UNIQUEMENT les informations du contexte fourni. N'invente rien, n'ajoute aucune connaissance externe ni exemple non présent dans le contexte.",
    "- Si l'information n'est pas dans le contexte, dis-le simplement en une phrase et invite à consulter les ressources du module. Ne refuse la réponse que si la question porte clairement sur un autre langage ou un sujet hors-sujet.",
    "- Tu peux t'appuyer sur les échanges précédents pour comprendre une question de suivi (« explique plus », « et pour ça ? »).",
    "",
    "Style de réponse :",
    "- Va droit au but : commence par une phrase qui répond directement, puis développe si utile.",
    "- Quand tu énumères des étapes ou des éléments, utilise une liste à puces courte plutôt qu'un long paragraphe.",
    "- Si le contexte contient du code C pertinent, illustre avec un petit bloc ```c ... ```.",
    "- Reste concis et naturel. Évite les formulations rigides comme « est défini comme suit » ou « le contexte indique ».",
    "- N'ajoute PAS de section « Sources » : les sources sont affichées automatiquement sous ta réponse.",
    "",
    lang === "en"
      ? "Langue : l'étudiant utilise l'interface en ANGLAIS. Réponds intégralement en anglais, même si la question ou le contexte sont en français (le code C reste inchangé)."
      : "Langue : réponds en français."
  ].join("\n");
  const userPrompt = [
    `Question de l'étudiant : ${question}`,
    "Contexte du module (seule source d'information autorisée) :",
    context,
    lang === "en"
      ? "Answer the question clearly and naturally in English, relying only on this context."
      : "Réponds à la question de façon claire, pédagogique et naturelle, en t'appuyant uniquement sur ce contexte."
  ].join("\n\n");

  return { systemPrompt, userPrompt };
}

export async function generateStudentChatAnswer(
  question: string,
  topChunks: StudentRagChunk[],
  history: StudentChatTurn[] = [],
  lang: "fr" | "en" = "fr"
): Promise<string | null> {
  if (!env.openaiApiKey && !env.geminiApiKey) {
    return null;
  }

  if (!topChunks.length) {
    return null;
  }

  const { systemPrompt, userPrompt } = buildStudentChatPrompts(question, topChunks, lang);

  if (env.geminiApiKey) {
    const chatModelName = await resolveGeminiModelForMethod(
      "generateContent",
      env.geminiChatModel,
      ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-pro"]
    );

    const response = await fetch(
      `${env.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(chatModelName)}:generateContent?key=${encodeURIComponent(env.geminiApiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            ...history.map((turn) => ({
              role: turn.role === "assistant" ? "model" : "user",
              parts: [{ text: turn.content }]
            })),
            {
              role: "user",
              parts: [{ text: userPrompt }]
            }
          ],
          generationConfig: {
            temperature: 0.2
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Gemini chat request failed (${response.status}): ${errorText}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const content = extractAssistantText(payload.candidates?.[0]?.content?.parts);
    if (content) {
      return content;
    }
  }

  if (!env.openaiApiKey) {
    return null;
  }

  const response = await fetch(`${env.openaiChatBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.openaiChatModel,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        {
          role: "user",
          content: userPrompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Chat completion failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };

  const content = extractAssistantText(payload.choices?.[0]?.message?.content);
  return content || null;
}

/**
 * Streams a grounded chat answer token-by-token via the OpenAI-compatible
 * (OpenRouter) chat endpoint, invoking `onDelta` for each text fragment.
 * Returns the full accumulated answer, or null if streaming was unavailable
 * (caller should fall back to the buffered path). Gemini has no streaming
 * branch here — when only Gemini is configured this returns null.
 */
export async function streamStudentChatAnswer(
  question: string,
  topChunks: StudentRagChunk[],
  history: StudentChatTurn[],
  onDelta: (delta: string) => void,
  lang: "fr" | "en" = "fr"
): Promise<string | null> {
  if (!env.openaiApiKey || !topChunks.length) {
    return null;
  }

  const { systemPrompt, userPrompt } = buildStudentChatPrompts(question, topChunks, lang);

  const response = await fetch(`${env.openaiChatBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.openaiChatModel,
      temperature: 0.2,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok || !response.body) {
    const errorText = response.ok ? "" : await response.text().catch(() => "");
    throw new Error(`Chat stream failed (${response.status}): ${errorText}`);
  }

  const reader = (response.body as any).getReader
    ? (response.body as unknown as ReadableStream<Uint8Array>).getReader()
    : null;
  if (!reader) {
    return null;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  // Parse the Server-Sent-Events stream: newline-delimited `data: {json}` lines,
  // each carrying an incremental `choices[0].delta.content` fragment.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      try {
        const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        // Ignore keep-alive comments / partial frames.
      }
    }
  }

  return full || null;
}
