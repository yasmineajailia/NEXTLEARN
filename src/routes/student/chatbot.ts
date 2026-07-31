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
import { rateLimit } from "../../middleware/rateLimit";
import { User } from "../../models/User";
import { buildLearnerProfile, type LearnerProfile } from "../../services/chatbot/learnerProfile";
import type { ModuleOverview } from "../../types/curriculum";
// Transitional: curriculum + class reads still live in web.ts.
import {
  readClassAccessByStudentIdentifier,
  readPersistedProgramCOverview
} from "../web";

export const chatbotRouter = Router();

const NO_MODULES_MESSAGE =
  "Je ne trouve aucun module disponible pour votre compte actuellement. Vérifiez votre calendrier ou contactez votre enseignant.";

// Each call hits a paid LLM API (+ the Python ML service); keyed per-student so
// one account can't throttle a whole class on a shared campus network, and
// generous enough (roughly one message every 6s, sustained) not to interrupt a
// student actively working through a lesson.
const chatbotLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  keyFn: (req) => req.auth?.id || req.ip || "unknown",
  message: "Trop de messages envoyés. Attendez quelques instants avant de continuer."
});

type ChatScope = { allowedModuleIds: string[]; allowedSubAcquisIds: string[] };

type ProgressUser = {
  progress?: {
    completedLessonKeys?: string[];
    skillAttempts?: Array<{ moduleId?: string; subAcquisId?: string }>;
  } | null;
} | null;

/**
 * Narrows the accessible overview to the student's progress frontier: the
 * furthest sous-acquis in curriculum order they have completed, attempted, or
 * are currently viewing — plus everything before it. This keeps the chatbot
 * from answering about content ahead of where the student has actually reached
 * (e.g. a student on 5.1 can ask about 1.1 … 5.1, but not 5.2+).
 */
export function restrictToProgressFrontier(
  overview: ModuleOverview[],
  user: ProgressUser,
  current?: { moduleId?: string; subAcquisId?: string }
): ModuleOverview[] {
  // Composite keys (moduleId::subAcquisId) in curriculum order.
  const ordered = [...overview].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const flatKeys: string[] = [];
  for (const moduleEntry of ordered) {
    for (const sub of moduleEntry.subAcquis) flatKeys.push(`${moduleEntry.id}::${sub.id}`);
  }

  const reached = new Set<string>();
  for (const key of user?.progress?.completedLessonKeys ?? []) reached.add(String(key));
  for (const attempt of user?.progress?.skillAttempts ?? []) {
    if (attempt?.moduleId && attempt?.subAcquisId) reached.add(`${attempt.moduleId}::${attempt.subAcquisId}`);
  }
  if (current?.moduleId && current?.subAcquisId) reached.add(`${current.moduleId}::${current.subAcquisId}`);

  // Furthest reached position; a student with no progress yet keeps just the
  // first sous-acquis so they can still ask about lesson one.
  let frontier = -1;
  flatKeys.forEach((key, index) => {
    if (reached.has(key)) frontier = Math.max(frontier, index);
  });
  if (frontier < 0) frontier = 0;

  const allowed = new Set(flatKeys.slice(0, frontier + 1));
  return overview
    .map((moduleEntry) => ({
      ...moduleEntry,
      subAcquis: moduleEntry.subAcquis.filter((sub) => allowed.has(`${moduleEntry.id}::${sub.id}`))
    }))
    .filter((moduleEntry) => moduleEntry.subAcquis.length > 0);
}

function toScope(overview: ModuleOverview[]): ChatScope | null {
  return overview.length
    ? {
        allowedModuleIds: overview.map((entry) => entry.id),
        allowedSubAcquisIds: overview.flatMap((entry) => entry.subAcquis.map((sub) => `${entry.id}::${sub.id}`))
      }
    : null;
}

/**
 * Resolves, from one set of reads, the learner profile plus TWO scopes:
 *  - scope: class access ∩ progress frontier — what retrieval actually draws
 *    answers from.
 *  - calendarScope: class access ALONE (no progress-frontier restriction) —
 *    passed through only so Python's "this is a real course topic, just not
 *    available yet" detector can tell apart two different reasons a topic
 *    might be outside `scope`: genuinely calendar-locked (calendarScope also
 *    excludes it — the calendar message is correct) vs. calendar-unlocked but
 *    not yet reached by this student (calendarScope DOES include it — telling
 *    them to "check the calendar" would be actively wrong, since the calendar
 *    already shows it as available).
 */
async function buildChatContext(
  identifier: string,
  filterToModuleId?: string,
  filterToSubAcquisId?: string
): Promise<{ scope: ChatScope | null; calendarScope: ChatScope | null; learnerProfile?: LearnerProfile }> {
  const [overview, access, user] = await Promise.all([
    readPersistedProgramCOverview(),
    readClassAccessByStudentIdentifier(identifier),
    User.findOne({ identifier }).select({ fullName: 1, progress: 1, varkProfile: 1 }).lean()
  ]);
  const accessibleOverview = filterOverviewByAccess(overview, access);
  // Class access ∩ what the student has actually progressed to.
  const scopedOverview = restrictToProgressFrontier(accessibleOverview, user as ProgressUser, {
    moduleId: filterToModuleId,
    subAcquisId: filterToSubAcquisId
  });
  const scope = toScope(scopedOverview);
  const calendarScope = toScope(accessibleOverview);
  const learnerProfile = buildLearnerProfile(user as never, overview, filterToSubAcquisId, filterToModuleId);
  return { scope, calendarScope, learnerProfile };
}

chatbotRouter.post("/api/student/chatbot", requireAuth, chatbotLimiter, async (req, res) => {
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

    const { scope, calendarScope, learnerProfile } = await buildChatContext(identifier, filterToModuleId, filterToSubAcquisId);
    if (!scope) {
      return res.status(200).json({ answer: NO_MODULES_MESSAGE });
    }

    const result = await answerViaPython({
      question: rawMessage,
      allowedModuleIds: scope.allowedModuleIds,
      allowedSubAcquisIds: scope.allowedSubAcquisIds,
      calendarAllowedModuleIds: calendarScope?.allowedModuleIds ?? [],
      calendarAllowedSubAcquisIds: calendarScope?.allowedSubAcquisIds ?? [],
      filterToModuleId,
      filterToSubAcquisId,
      history,
      lang,
      learnerProfile
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
chatbotRouter.post("/api/student/chatbot/stream", requireAuth, chatbotLimiter, async (req, res) => {
  const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
  const rawMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return; // client gone — don't write to a closed socket
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Abort the upstream ML read if the browser disconnects mid-stream.
  const clientGone = new AbortController();
  res.on("close", () => clientGone.abort());

  if (!identifier || !rawMessage) {
    send("error", { message: !identifier ? "Identifiant requis" : "Question requise" });
    return res.end();
  }

  try {
    const filterToModuleId = typeof req.body?.filterToModuleId === "string" ? req.body.filterToModuleId.trim() : undefined;
    const filterToSubAcquisId = typeof req.body?.filterToSubAcquisId === "string" ? req.body.filterToSubAcquisId.trim() : undefined;
    const history = normalizeChatHistory(req.body?.history);
    const lang: "fr" | "en" = req.body?.lang === "en" ? "en" : "fr";

    const { scope, calendarScope, learnerProfile } = await buildChatContext(identifier, filterToModuleId, filterToSubAcquisId);
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
        calendarAllowedModuleIds: calendarScope?.allowedModuleIds ?? [],
        calendarAllowedSubAcquisIds: calendarScope?.allowedSubAcquisIds ?? [],
        filterToModuleId,
        filterToSubAcquisId,
        history,
        lang,
        learnerProfile
      },
      (chunk) => { if (!res.writableEnded) res.write(chunk); },
      clientGone.signal
    );
    return res.end();
  } catch (error) {
    // A client disconnect aborts the upstream read; that's expected, not an error.
    if (!clientGone.signal.aborted) {
      console.error("Failed to stream student chatbot answer:", error);
      send("error", { message: "Impossible de générer une réponse pour le moment" });
    }
    return res.end();
  }
});
