/**
 * Student chatbot routes (buffered + SSE streaming) and request orchestration:
 * load the student's accessible curriculum, retrieve grounded context through
 * the RAG engine, and generate the answer in the UI language.
 */
import { Router } from "express";
import {
  buildStudentRagAnswer,
  ensureStudentVectorStore,
  evaluateQuestionAgainstScopedModule,
  generateStudentChatAnswer,
  getStudentVectorMatches,
  isAnswerGroundedInChunks,
  isQuestionOutsideLangageC,
  isRefusalLikeAnswer,
  normalizeChatHistory,
  refineStudentRagChunks,
  streamStudentChatAnswer,
  type StudentRagChunk
} from "../../services/chatbot/rag";
import { hasEmbeddingProvider } from "../../services/llm";
import { filterOverviewByAccess } from "../../services/classAccess";
import { normalizeWhitespace } from "../../services/textNormalize";
// Transitional: curriculum + class reads still live in web.ts.
import {
  readClassAccessByStudentIdentifier,
  readPersistedCurriculumModules,
  readPersistedProgramCOverview
} from "../web";

export const chatbotRouter = Router();


type StudentChatSource = {
  moduleId: string;
  moduleName: string;
  subAcquisId: string | null;
  subAcquisName: string | null;
  kind: string;
  excerpt: string;
};

type StudentChatContext =
  | { kind: "empty"; answer: string }
  | { kind: "scope-guard"; answer: string; embeddingScope?: unknown }
  | { kind: "ok"; refinedChunks: StudentRagChunk[]; sources: StudentChatSource[]; responseMode: string };

/**
 * Shared retrieval + scope-guard pipeline for both the buffered and streaming
 * chatbot endpoints. Returns the retrieved/refined chunks and their source
 * descriptors, or an early-exit answer (no access / out-of-scope).
 */
async function buildStudentChatContext(params: {
  identifier: string;
  rawMessage: string;
  filterToModuleId?: string;
  filterToSubAcquisId?: string;
}): Promise<StudentChatContext> {
  const { identifier, rawMessage, filterToModuleId, filterToSubAcquisId } = params;

  const [overview, persistedModules, access] = await Promise.all([
    readPersistedProgramCOverview(),
    readPersistedCurriculumModules(),
    readClassAccessByStudentIdentifier(identifier)
  ]);

  const accessibleOverview = filterOverviewByAccess(overview, access);
  if (!accessibleOverview.length) {
    return {
      kind: "empty",
      answer:
        "Je ne trouve aucun module disponible pour votre compte actuellement. Vérifiez votre calendrier ou contactez votre enseignant."
    };
  }

  const rankedChunks = await getStudentVectorMatches({
    persistedModules,
    accessibleOverview,
    question: rawMessage,
    filterToModuleId,
    filterToSubAcquisId
  });

  const refinedChunks = refineStudentRagChunks(rawMessage, rankedChunks);

  // Refuse when question is about another language. The embedding scope-check
  // is only a diagnostic on this refusal, so it is computed lazily here rather
  // than on every request (it embeds the query + scans all module vectors).
  if ((filterToModuleId || filterToSubAcquisId) && isQuestionOutsideLangageC(rawMessage)) {
    const embeddingScopeCheck = filterToModuleId
      ? await evaluateQuestionAgainstScopedModule({
          persistedModules,
          accessibleOverview,
          question: rawMessage,
          targetModuleId: filterToModuleId
        })
      : null;

    return {
      kind: "scope-guard",
      answer:
        "Je peux vous aider uniquement sur le module en cours et en langage C. Reformulez votre question sans mentionner un autre langage.",
      embeddingScope: embeddingScopeCheck
        ? {
            targetModuleId: filterToModuleId || null,
            targetScore: Number(embeddingScopeCheck.targetScore.toFixed(4)),
            topModuleId: embeddingScopeCheck.topModuleId,
            topScore: Number(embeddingScopeCheck.topScore.toFixed(4))
          }
        : undefined
    };
  }

  const sources: StudentChatSource[] = refinedChunks.map((chunk) => ({
    moduleId: chunk.moduleId,
    moduleName: chunk.moduleName,
    subAcquisId: chunk.subAcquisId,
    subAcquisName: chunk.subAcquisName,
    kind: chunk.kind,
    excerpt: normalizeWhitespace(String(chunk.text || "")).slice(0, 300)
  }));

  return {
    kind: "ok",
    refinedChunks,
    sources,
    responseMode: hasEmbeddingProvider() ? "vector" : "rag"
  };
}

chatbotRouter.post("/api/student/chatbot", async (req, res) => {
  try {
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
    const rawMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";

    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }

    if (!rawMessage) {
      return res.status(400).json({ message: "Question requise" });
    }

    const filterToModuleId = typeof req.body?.filterToModuleId === "string" ? req.body.filterToModuleId.trim() : undefined;
    const filterToSubAcquisId = typeof req.body?.filterToSubAcquisId === "string" ? req.body.filterToSubAcquisId.trim() : undefined;
    const history = normalizeChatHistory(req.body?.history);
    const lang: "fr" | "en" = req.body?.lang === "en" ? "en" : "fr";

    const context = await buildStudentChatContext({ identifier, rawMessage, filterToModuleId, filterToSubAcquisId });

    if (context.kind === "empty") {
      return res.status(200).json({ answer: context.answer });
    }
    if (context.kind === "scope-guard") {
      return res.status(200).json({
        answer: context.answer,
        mode: "scope-guard",
        retrieved: 0,
        sources: [],
        embeddingScope: context.embeddingScope
      });
    }

    let answer = buildStudentRagAnswer(rawMessage, context.refinedChunks);
    let responseMode = context.responseMode;

    try {
      const generated = await generateStudentChatAnswer(rawMessage, context.refinedChunks, history, lang);
      if (generated && !isRefusalLikeAnswer(generated) && isAnswerGroundedInChunks(generated, context.refinedChunks)) {
        answer = generated;
        responseMode = `${responseMode}+llm`;
      }
    } catch (error) {
      console.warn("Chat generation failed; using deterministic fallback:", error);
    }

    return res.status(200).json({
      answer,
      mode: responseMode,
      retrieved: context.sources.length,
      sources: context.sources
    });
  } catch (error) {
    console.error("Failed to answer student chatbot question:", error);
    return res.status(500).json({ message: "Impossible de générer une réponse pour le moment" });
  }
});

// Streaming variant: emits Server-Sent Events so answers render token-by-token.
// Events: `delta` { text }, `sources` { sources }, `meta` { mode }, `done` {}, `error` { message }.
chatbotRouter.post("/api/student/chatbot/stream", async (req, res) => {
  const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
  const rawMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!identifier || !rawMessage) {
    send("error", { message: !identifier ? "Identifiant requis" : "Question requise" });
    return res.end();
  }

  try {
    const filterToModuleId = typeof req.body?.filterToModuleId === "string" ? req.body.filterToModuleId.trim() : undefined;
    const filterToSubAcquisId = typeof req.body?.filterToSubAcquisId === "string" ? req.body.filterToSubAcquisId.trim() : undefined;
    const history = normalizeChatHistory(req.body?.history);
    const lang: "fr" | "en" = req.body?.lang === "en" ? "en" : "fr";

    const context = await buildStudentChatContext({ identifier, rawMessage, filterToModuleId, filterToSubAcquisId });

    if (context.kind === "empty" || context.kind === "scope-guard") {
      send("meta", { mode: context.kind === "scope-guard" ? "scope-guard" : "empty" });
      send("delta", { text: context.answer });
      send("sources", { sources: [] });
      send("done", {});
      return res.end();
    }

    send("meta", { mode: `${context.responseMode}+stream` });

    let streamed: string | null = null;
    try {
      streamed = await streamStudentChatAnswer(rawMessage, context.refinedChunks, history, (delta) => {
        send("delta", { text: delta });
      }, lang);
    } catch (error) {
      console.warn("Chat stream failed; using deterministic fallback:", error);
    }

    // No streaming provider (or it failed): emit the deterministic answer at once.
    if (!streamed) {
      const fallback = buildStudentRagAnswer(rawMessage, context.refinedChunks);
      send("delta", { text: fallback });
    }

    send("sources", { sources: context.sources });
    send("done", {});
    return res.end();
  } catch (error) {
    console.error("Failed to stream student chatbot answer:", error);
    send("error", { message: "Impossible de générer une réponse pour le moment" });
    return res.end();
  }
});

export async function warmStudentVectorStore(): Promise<void> {
  if (!hasEmbeddingProvider()) {
    return;
  }
  try {
    const persistedModules = await readPersistedCurriculumModules();
    await ensureStudentVectorStore(persistedModules);
  } catch (error) {
    console.warn("[chatbot] Vector store warm-up failed:", error);
  }
}
