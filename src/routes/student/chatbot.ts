/**
 * Student chatbot routes (buffered + SSE streaming).
 *
 * RAG serving lives entirely in the Python ML service now (retrieval over
 * ChromaDB + scope guards + LLM generation). These routes are a thin proxy:
 * Node resolves the student's accessible curriculum (access control) and passes
 * the allowed module/sub-acquis ids to Python, which does everything else.
 */
import { Router } from "express";
import {
  answerViaPython,
  streamViaPython,
  normalizeChatHistory
} from "../../services/chatbot/ragClient";
import { filterOverviewByAccess } from "../../services/classAccess";
import { requireAuth } from "../../middleware/auth";
// Transitional: curriculum + class reads still live in web.ts.
import {
  readClassAccessByStudentIdentifier,
  readPersistedProgramCOverview
} from "../web";

export const chatbotRouter = Router();

const NO_MODULES_MESSAGE =
  "Je ne trouve aucun module disponible pour votre compte actuellement. Vérifiez votre calendrier ou contactez votre enseignant.";

/**
 * Resolves the modules a student may ask about (access control) and flattens
 * them into the id lists Python needs. Returns null when the student has no
 * accessible modules.
 */
async function resolveAllowedScope(identifier: string): Promise<{
  allowedModuleIds: string[];
  allowedSubAcquisIds: string[];
} | null> {
  const [overview, access] = await Promise.all([
    readPersistedProgramCOverview(),
    readClassAccessByStudentIdentifier(identifier)
  ]);
  const accessibleOverview = filterOverviewByAccess(overview, access);
  if (!accessibleOverview.length) {
    return null;
  }
  return {
    allowedModuleIds: accessibleOverview.map((entry) => entry.id),
    allowedSubAcquisIds: accessibleOverview.flatMap((entry) =>
      entry.subAcquis.map((sub) => `${entry.id}::${sub.id}`)
    )
  };
}

chatbotRouter.post("/api/student/chatbot", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
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

    const scope = await resolveAllowedScope(identifier);
    if (!scope) {
      return res.status(200).json({ answer: NO_MODULES_MESSAGE });
    }

    const result = await answerViaPython({
      question: rawMessage,
      allowedModuleIds: scope.allowedModuleIds,
      allowedSubAcquisIds: scope.allowedSubAcquisIds,
      filterToModuleId,
      filterToSubAcquisId,
      history,
      lang
    });

    return res.status(200).json({
      answer: result.answer,
      mode: result.mode,
      retrieved: result.retrieved,
      sources: result.sources
    });
  } catch (error) {
    console.error("Failed to answer student chatbot question:", error);
    return res.status(500).json({ message: "Impossible de générer une réponse pour le moment" });
  }
});

// Streaming variant: emits Server-Sent Events so answers render token-by-token.
// Events: `meta` { mode }, `delta` { text }, `sources` { sources }, `done` {}, `error` { message }.
// Python emits the frames; Node does access control then pipes them verbatim.
chatbotRouter.post("/api/student/chatbot/stream", requireAuth, async (req, res) => {
  const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
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

    const scope = await resolveAllowedScope(identifier);
    if (!scope) {
      send("meta", { mode: "empty" });
      send("delta", { text: NO_MODULES_MESSAGE });
      send("sources", { sources: [] });
      send("done", {});
      return res.end();
    }

    await streamViaPython(
      {
        question: rawMessage,
        allowedModuleIds: scope.allowedModuleIds,
        allowedSubAcquisIds: scope.allowedSubAcquisIds,
        filterToModuleId,
        filterToSubAcquisId,
        history,
        lang
      },
      (chunk) => res.write(chunk)
    );
    return res.end();
  } catch (error) {
    console.error("Failed to stream student chatbot answer:", error);
    send("error", { message: "Impossible de générer une réponse pour le moment" });
    return res.end();
  }
});
