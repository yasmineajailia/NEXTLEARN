/**
 * quizzes.routes.ts
 *
 * Teacher AI quiz generation, regeneration, validation and rejection.
 * Split out of the former monolithic web.ts; shares helpers via ./shared.js.
 */
import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import JSZip from "jszip";
import { authRouter } from "../auth";
import { User } from "../../models/User";
import { Teacher } from "../../models/Teacher";
import { ClassRoom } from "../../models/ClassRoom";
import { StudentProfile } from "../../models/StudentProfile";
import { CurriculumModule } from "../../models/CurriculumModule";
import { StudentRemediationQuiz } from "../../models/StudentRemediationQuiz";
import { hashPassword } from "../../utils/password";
import { Recommender, type ChapterScoreEntry, type RecommendOptions, type ScoreEntry, type SkillsJson } from "../../services/recommendation/skill-recommender.js";
import { computeRemediationTargets, type RemediationTarget } from "../../services/recommendation/remediationTargets.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { computeItemAnalysis, type ItemAttempt } from "../../services/quiz/itemAnalysisClient.js";
import { env } from "../../config/env";
import { MLPredictorService } from "../../services/MLPredictorService";
import { type PredictionFeatures, type PredictionModuleInfo, extractMLFeatures } from "../../services/prediction/features";
import { resolveRiskExplanation } from "../../services/prediction/explain";
import { buildLessonKey, computeModuleQuizScores, computeStudentProgress } from "../../services/studentProgress";
import {
  isSubAcquisAccessibleByAccessRules,
  buildScheduleBySubAcquis,
  parseStartDateInput,
  parseCalendarWeekMap,
  readCalendarWeekMapFromFile,
  toAccessRecord,
  toIsoDateOrNull,
  toScheduleIsoRecord,
  filterOverviewByAccess,
  toStudentCalendarEntries
} from "../../services/classAccess";
import {
  generateTeacherQuizQuestions,
  type TeacherGeneratedQuestion
} from "../../services/quiz/quizGenClient";
import {
  buildMediaPublicUrl,
  canonicalMediaKey,
  extractCourseContentSnippetsFromUrl,
  extractGridFsFileIdFromMediaUrl,
  getCurriculumMediaBucket,
  isLocalMediaUrl,
  mirrorPublicFileToGridFs,
  readBufferFromCourseFileUrl,
  uploadBufferToGridFs,
  inferContentType,
  resolveLocalPathFromPublicUrl
} from "../../services/courseContent";
import { requestPythonReindex } from "../../services/chatbot/ragClient";
import {
  normalizeForComparison,
  normalizeForLookup,
  normalizeWhitespace,
  stripTrailingLevelNumber
} from "../../services/textNormalize";
import { moduleDocToOverview } from "../../services/curriculum";
import type {
  ClassAccessContext,
  CurriculumAcquis,
  CurriculumCourseFile,
  CurriculumModuleDoc,
  CurriculumQuiz,
  CurriculumQuizQuestion,
  CurriculumSubAcquis,
  CurriculumVideo,
  ModuleOverview,
  QuizJsonPayload,
  QuizQuestion,
  StudentCalendarEntry,
  SubAcquisOverview
} from "../../types/curriculum";

import {
  CurriculumNamesData,
  QUIZ_MAX_ATTEMPTS,
  QUIZ_PASS_SCORE,
  QuizAttemptState,
  RecommendationGraphNode,
  RecommendationGraphPayload,
  SELF_EVALUATION_PASS_SCORE,
  SESSION_TTL,
  SelfEvaluationResult,
  TeacherQuizGenerationSession,
  applyCurriculumNames,
  buildCourseFileEntries,
  buildCurriculumSeedFromFilesystem,
  buildRemediationQuizJsonFilePath,
  buildSelfEvaluationOverview,
  buildSourceUploadPath,
  buildVideoEntries,
  cleanExpiredSessions,
  collectAcquisQuizQuestions,
  convertPowerPointToPdf,
  createStableId,
  ensureCurriculumSeeded,
  escapePowerShellSingleQuoted,
  execFileAsync,
  extractHttpLinksFromUnknownPayload,
  extractSelfEvaluationResults,
  findFirstDirectoryByName,
  generateSessionId,
  generatedQuizzesRoot,
  hasActiveRemediationQuiz,
  hasMissingFilesystemCurriculumEntries,
  hasRenderableCurriculum,
  listSubAcquisIds,
  loadRecommendationGraph,
  makeSelfEvaluationKey,
  mergeMissingCurriculumEntries,
  moduleDocToPublic,
  normalizeRecommendationGraph,
  parseCompletedIds,
  parseCurriculumNamesText,
  parseNormalizedQuizJson,
  parseQuizDocxRawText,
  parseSkillScores,
  parseSubSkillScores,
  pickRecommendationMode,
  publicRoot,
  readClassAccessByStudentIdentifier,
  readCurriculumNamesFromFile,
  readExternalVideoLinks,
  readPersistedCurriculumModules,
  readPersistedProgramCOverview,
  readPersistedSubAcquisResources,
  readProgramCOverview,
  readQuizAttemptState,
  readSubAcquisResources,
  recommendationGraphPath,
  sanitizePathSegment,
  savePersistedCurriculumModules,
  saveRemediationQuizJsonFile,
  scoreSelfEvaluationQuestions,
  subAcquisHasQuiz,
  subAcquisHasVideo,
  supportPublicPrefix,
  supportRoot,
  teacherQuizSessions,
  toCurriculumQuestion,
  toPublicPath,
} from "./shared.js";

export const quizzesRouter = Router();

// Each call hits a paid LLM API; keyed per-teacher (not per-IP) so one account
// generating quizzes doesn't throttle every other teacher on a shared network.
const quizGenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  keyFn: (req) => req.auth?.id || req.ip || "unknown",
  message: "Trop de générations de quiz. Réessayez dans quelques minutes."
});

quizzesRouter.post("/api/teacher/quizzes/generate", requireRole("enseignant", "admin"), quizGenLimiter, async (req, res) => {
  try {
    cleanExpiredSessions();

    const moduleId = typeof req.body?.moduleId === "string" ? req.body.moduleId.trim() : "";
    const subAcquisId = typeof req.body?.subAcquisId === "string" ? req.body.subAcquisId.trim() : "";
    const subAcquisNameFallback = typeof req.body?.subAcquisName === "string" ? req.body.subAcquisName.trim() : "";
    const acquisNameFallback = typeof req.body?.acquisName === "string" ? req.body.acquisName.trim() : "";
    const difficulty = req.body?.difficulty || "intermediate";
    const count = Math.min(Math.max(Number(req.body?.count) || 5, 1), 10);

    if (!moduleId || (!subAcquisId && !subAcquisNameFallback)) {
      return res.status(400).json({
        message: "moduleId et (subAcquisId ou subAcquisName) sont requis"
      });
    }

    // Validate difficulty
    if (!["beginner", "intermediate", "advanced"].includes(difficulty)) {
      return res.status(400).json({
        message: "difficulty doit être 'beginner', 'intermediate' ou 'advanced'"
      });
    }

    const modules = await readPersistedCurriculumModules();
    const module = modules.find((m) => m.id === moduleId);
    if (!module) {
      return res.status(404).json({ message: "Module introuvable" });
    }

    const subAcquis = subAcquisId
      ? module.acquis.flatMap((a) => a.sousAcquis).find((s) => s.id === subAcquisId)
      : undefined;
    if (!subAcquis && !subAcquisNameFallback) {
      return res.status(404).json({ message: "Sous-acquis introuvable" });
    }
    const resolvedSubAcquisName = subAcquis?.name || subAcquisNameFallback || subAcquisId;

    // Resolve acquis name: prefer DB lookup (find parent acquis of the subAcquis), fall back to request body
    const parentAcquis = subAcquisId
      ? module.acquis.find((a) => Array.isArray(a.sousAcquis) && a.sousAcquis.some((s) => s.id === subAcquisId))
      : undefined;
    const resolvedAcquisName = parentAcquis?.name || acquisNameFallback;

    // Extract course content from all uploaded files (PDF and PPTX)
    let courseContent: string[] = [];
    if (subAcquis && Array.isArray(subAcquis.courseFiles) && subAcquis.courseFiles.length > 0) {
      const fileResults = await Promise.allSettled(
        subAcquis.courseFiles.map((f: { url: string }) => extractCourseContentSnippetsFromUrl(f.url))
      );
      for (const result of fileResults) {
        if (result.status === "fulfilled") {
          courseContent.push(...result.value);
          if (courseContent.length >= 9) break;
        }
      }
      courseContent = courseContent.slice(0, 9);
    }

    const breadcrumb = [module.name || moduleId, resolvedAcquisName, resolvedSubAcquisName].filter(Boolean).join(" > ");

    // Generate questions
    const generatedQuestions = await generateTeacherQuizQuestions({
      moduleId,
      moduleName: module.name || moduleId,
      acquisName: resolvedAcquisName,
      subAcquisId: subAcquisId || resolvedSubAcquisName,
      subAcquisName: resolvedSubAcquisName,
      difficulty,
      count,
      courseContent
    });

    // Store in session
    const sessionId = generateSessionId();
    const session: TeacherQuizGenerationSession = {
      sessionId,
      moduleId,
      moduleName: module.name || moduleId,
      subAcquisId: subAcquisId || resolvedSubAcquisName,
      subAcquisName: resolvedSubAcquisName,
      topic: breadcrumb,
      difficulty,
      count,
      questions: generatedQuestions,
      createdAt: new Date()
    };
    teacherQuizSessions.set(sessionId, session);

    res.status(200).json({
      sessionId,
      count: generatedQuestions.length,
      questions: generatedQuestions.map((q, index) => ({
        index,
        prompt: q.prompt,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
        source: q.source || "unknown"
      }))
    });
  } catch (error) {
    console.error("Failed to generate quiz questions:", error);
    res.status(500).json({ message: "Impossible de générer les questions" });
  }
});

// Endpoint: Regenerate specific questions or the entire batch
quizzesRouter.post("/api/teacher/quizzes/regenerate", requireRole("enseignant", "admin"), quizGenLimiter, async (req, res) => {
  try {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    const regenerateAll = Boolean(req.body?.regenerateAll);
    const indices = Array.isArray(req.body?.indices)
      ? req.body.indices.filter((i: any) => Number.isInteger(i)).map(Number)
      : [];

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId requis" });
    }

    const session = teacherQuizSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ message: "Session expirée ou introuvable" });
    }

    let indicesToRegenerate = regenerateAll ? Array.from(Array(session.count).keys()) : indices;
    if (indicesToRegenerate.length === 0) {
      indicesToRegenerate = [0];
    }

    // Validate indices
    indicesToRegenerate = indicesToRegenerate.filter((i: number) => i >= 0 && i < session.questions.length);
    if (indicesToRegenerate.length === 0) {
      return res.status(400).json({ message: "Aucun index valide à régénérer" });
    }

    // Regenerate selected questions
    const regeneratedQuestions = await generateTeacherQuizQuestions({
      moduleId: session.moduleId,
      moduleName: session.moduleName,
      subAcquisId: session.subAcquisId,
      subAcquisName: session.subAcquisName,
      topic: session.topic,
      difficulty: session.difficulty,
      count: indicesToRegenerate.length
    });

    // Update session with regenerated questions
    let regeneratedIndex = 0;
    for (const index of indicesToRegenerate) {
      if (regeneratedIndex < regeneratedQuestions.length) {
        session.questions[index] = regeneratedQuestions[regeneratedIndex];
        regeneratedIndex += 1;
      }
    }

    res.status(200).json({
      sessionId,
      regeneratedCount: regeneratedIndex,
      questions: session.questions.map((q, index) => ({
        index,
        prompt: q.prompt,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
        source: q.source || "unknown"
      }))
    });
  } catch (error) {
    console.error("Failed to regenerate quiz questions:", error);
    res.status(500).json({ message: "Impossible de régénérer les questions" });
  }
});

// Endpoint: Validate and save approved questions to the quiz
quizzesRouter.post("/api/teacher/quizzes/validate", requireRole("enseignant", "admin"), async (req, res) => {
  try {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    const questionIndices = Array.isArray(req.body?.questionIndices)
      ? req.body.questionIndices.filter((i: any) => Number.isInteger(i)).map(Number)
      : [];
    const quizTitle = typeof req.body?.quizTitle === "string" ? req.body.quizTitle.trim() : "Generated Quiz";

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId requis" });
    }

    if (questionIndices.length === 0) {
      return res.status(400).json({ message: "Au moins une question doit être sélectionnée" });
    }

    const session = teacherQuizSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ message: "Session expirée ou introuvable" });
    }

    // Validate indices
    const validIndices = questionIndices.filter((i: number) => i >= 0 && i < session.questions.length);
    if (validIndices.length === 0) {
      return res.status(400).json({ message: "Aucun index valide sélectionné" });
    }

    // Extract selected questions
    const selectedQuestions = validIndices.map((i: number) => session.questions[i]);

    // Load module and add questions to quiz
    const modules = await readPersistedCurriculumModules();
    const module = modules.find((m) => m.id === session.moduleId);
    if (!module) {
      return res.status(404).json({ message: "Module introuvable" });
    }

    const subAcquis = module.acquis
      .flatMap((a) => a.sousAcquis)
      .find((s) => s.id === session.subAcquisId);
    if (!subAcquis) {
      return res.status(404).json({ message: "Sous-acquis introuvable" });
    }

    // Create new quiz or update existing one
    const quizId = `quiz-${Date.now()}`;
    const newQuiz: CurriculumQuiz = {
      id: quizId,
      type: "generated",
      title: quizTitle || `Quiz: ${session.topic}`,
      questions: selectedQuestions.map((q: TeacherGeneratedQuestion) => ({
        prompt: q.prompt,
        options: q.options,
        correctAnswerIndex: q.correctOptionIndex
      }))
    };

    // Add quiz to sub-acquis
    if (!Array.isArray(subAcquis.quizzes)) {
      subAcquis.quizzes = [];
    }
    subAcquis.quizzes.push(newQuiz);

    // Save updated module
    await savePersistedCurriculumModules(modules as CurriculumModuleDoc[]);

    // Clean up session
    teacherQuizSessions.delete(sessionId);

    res.status(200).json({
      success: true,
      quizId,
      quizTitle: newQuiz.title,
      questionCount: newQuiz.questions.length,
      message: `${newQuiz.questions.length} questions ajoutées au quiz`
    });
  } catch (error) {
    console.error("Failed to validate and save quiz questions:", error);
    res.status(500).json({ message: "Impossible d'enregistrer les questions" });
  }
});

// Endpoint: Reject generated questions and clear session
quizzesRouter.post("/api/teacher/quizzes/reject", requireRole("enseignant", "admin"), async (req, res) => {
  try {
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId requis" });
    }

    const had = teacherQuizSessions.has(sessionId);
    teacherQuizSessions.delete(sessionId);

    res.status(200).json({
      success: true,
      deleted: had,
      message: had ? "Session supprimée" : "Session non trouvée"
    });
  } catch (error) {
    console.error("Failed to reject quiz session:", error);
    res.status(500).json({ message: "Impossible de supprimer la session" });
  }
});



