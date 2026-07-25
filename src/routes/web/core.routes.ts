/**
 * core.routes.ts
 *
 * Health check + recommendation engine endpoints.
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

export const coreRouter = Router();

coreRouter.get("/api/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "nextlearn-web"
  });
});

coreRouter.post("/api/recommendations", async (req, res) => {
  try {
    const graph = await loadRecommendationGraph();
    if (!graph) {
      return res.status(500).json({ message: "Unable to load graph.json" });
    }

    const recommender = new Recommender(graph);
    recommender.setCompleted(parseCompletedIds(req.body));
    recommender.loadSubSkillScores(parseSubSkillScores(req.body));
    recommender.loadSkillScores(parseSkillScores(req.body));

    const mode = pickRecommendationMode(req.body);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(1, Number(req.body.limit)) : undefined;
    const sortBy = req.body?.sortBy === "unlocks" || req.body?.sortBy === "id" ? req.body.sortBy : "readiness";
    const includePartial = req.body?.includePartial !== false;
    const skillId = typeof req.body?.skillId === "string" ? req.body.skillId.trim() : "";

    let result: unknown;
    if (mode === "recommend") {
      const options: RecommendOptions = { sortBy, limit, includePartial };
      result = recommender.recommend(options);
    } else if (mode === "remediation") {
      result = recommender.remediation({ limit });
    } else if (mode === "revisit") {
      result = recommender.revisit({ limit });
    } else if (mode === "report") {
      result = recommender.skillScoreReport();
    } else {
      result = recommender.snapshot();
    }

    const response: Record<string, unknown> = {
      mode,
      result
    };

    if (skillId) {
      response.skill = graph[skillId]
        ? {
            id: skillId,
            title: graph[skillId].title,
            status: recommender.status(skillId),
            readiness: recommender.readiness(skillId),
            readinessPct: Math.round(recommender.readiness(skillId) * 100),
            prerequisiteProgress: recommender.prerequisiteProgress(skillId),
            unlockImpact: recommender.unlockImpact(skillId),
            isWeak: recommender.isWeak(skillId)
          }
        : null;
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("Failed to compute recommendations:", error);
    return res.status(500).json({ message: "Unable to compute recommendations" });
  }
});

// Main page endpoint.
// Sends the static HTML file rendered by the browser.

