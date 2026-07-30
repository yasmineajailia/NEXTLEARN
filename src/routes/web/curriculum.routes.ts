/**
 * curriculum.routes.ts
 *
 * Student module lists, programmation-C content and curriculum CRUD.
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

export const curriculumRouter = Router();

curriculumRouter.get("/api/student/modules", async (req, res) => {
  try {
    const overview = await readPersistedProgramCOverview();

    const modules = overview.map((moduleData) => ({
      id: moduleData.id,
      name: moduleData.name,
      sortOrder: moduleData.sortOrder,
      subAcquisCount: moduleData.subAcquisCount,
      subAcquis: moduleData.subAcquis.map((entry) => entry.id),
      subAcquisDetails: moduleData.subAcquis.map((entry) => ({
        id: entry.id,
        name: entry.name
      }))
    }));

    res.status(200).json({ modules });
  } catch (error) {
    console.error("Failed to read student modules:", error);
    res.status(500).json({ message: "Unable to load modules" });
  }
});

// Full module detail for student view: returns acquis[] → sousAcquis[] hierarchy.
curriculumRouter.get("/api/student/module/:moduleId", async (req, res) => {
  try {
    const moduleId = String(req.params.moduleId || "").trim();
    if (!moduleId) {
      return res.status(400).json({ message: "moduleId is required" });
    }

    const modules = await readPersistedCurriculumModules();
    const mod = modules.find((m) => m.id === moduleId);
    if (!mod) {
      return res.status(404).json({ message: "Module not found" });
    }

    const acquis = (Array.isArray(mod.acquis) ? mod.acquis : []).map((acq) => ({
      id: acq.id,
      name: acq.name,
      sousAcquis: (Array.isArray(acq.sousAcquis) ? acq.sousAcquis : []).map((sub) => ({
        id: sub.id,
        name: sub.name,
        bloomLevel: sub.bloomLevel || "",
        lessonsCount: Number(sub.lessonsCount || 0),
        hasQuiz: Array.isArray(sub.quizzes) && sub.quizzes.length > 0,
        hasVideo:
          (Array.isArray(sub.videos) && sub.videos.length > 0) ||
          Boolean(sub.resource?.ref)
      }))
    }));

    return res.status(200).json({
      module: { id: mod.id, name: mod.name, acquis }
    });
  } catch (error) {
    console.error("Failed to read module detail:", error);
    return res.status(500).json({ message: "Unable to load module" });
  }
});

// Programmation C modules endpoint.
// Reads modules from the MongoDB curriculum collection.
curriculumRouter.get("/api/programmation-c/modules", async (req, res) => {
  try {
    const overview = await readPersistedProgramCOverview();

    const modules = overview.map((moduleData) => ({
      id: moduleData.id,
      name: moduleData.name,
      sortOrder: moduleData.sortOrder,
      subAcquisCount: moduleData.subAcquisCount,
      subAcquis: moduleData.subAcquis.map((entry) => entry.id),
      subAcquisDetails: moduleData.subAcquis.map((entry) => ({
        id: entry.id,
        name: entry.name
      }))
    }));

    res.status(200).json({ modules });
  } catch (error) {
    console.error("Failed to read programmation C modules:", error);
    res.status(500).json({ message: "Unable to load programmation C modules" });
  }
});

curriculumRouter.get("/api/programmation-c/overview", requireAuth, async (req, res) => {
  try {
    const modules = await readPersistedProgramCOverview();
    const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
    const access = await readClassAccessByStudentIdentifier(identifier);
    const filteredModules = filterOverviewByAccess(modules, access);

    res.status(200).json({ modules: filteredModules });
  } catch (error) {
    console.error("Failed to read programmation C overview:", error);
    res.status(500).json({ message: "Unable to load programmation C overview" });
  }
});

curriculumRouter.get("/api/backoffice/curriculum", requireRole("enseignant", "admin"), async (_req, res) => {
  try {
    const modules = await readPersistedCurriculumModules();
    res.status(200).json({ modules });
  } catch (error) {
    console.error("Failed to load backoffice curriculum:", error);
    res.status(500).json({ message: "Impossible de charger le curriculum" });
  }
});

curriculumRouter.put("/api/backoffice/curriculum", requireRole("enseignant", "admin"), async (req, res) => {
  try {
    const incomingModules = Array.isArray(req.body?.modules) ? req.body.modules : [];

    if (!incomingModules.length) {
      return res.status(400).json({ message: "Le tableau des modules est requis" });
    }

    const normalizedModules = incomingModules
      .map((module: any) => ({
        id: typeof module?.id === "string" ? module.id.trim() : "",
        name: typeof module?.name === "string" ? module.name.trim() : "",
        acquis: Array.isArray(module?.acquis)
          ? module.acquis.map((acquis: any) => ({
              id: typeof acquis?.id === "string" ? acquis.id.trim() : "",
              name: typeof acquis?.name === "string" ? acquis.name.trim() : "",
              isDefaultBucket: Boolean(acquis?.isDefaultBucket),
              sousAcquis: Array.isArray(acquis?.sousAcquis)
                ? acquis.sousAcquis.map((subAcquis: any) => ({
                    id: typeof subAcquis?.id === "string" ? subAcquis.id.trim() : "",
                    name: typeof subAcquis?.name === "string" ? subAcquis.name.trim() : "",
                    bloomLevel: typeof subAcquis?.bloomLevel === "string" ? subAcquis.bloomLevel.trim() : "",
                    resource: subAcquis?.resource && typeof subAcquis.resource === "object"
                      ? {
                          type: typeof subAcquis.resource.type === "string" ? subAcquis.resource.type : "",
                          ref: typeof subAcquis.resource.ref === "string" ? subAcquis.resource.ref : ""
                        }
                      : { type: "", ref: "" },
                    lessonsCount: Number(subAcquis?.lessonsCount || 0),
                    courseFiles: Array.isArray(subAcquis?.courseFiles)
                      ? subAcquis.courseFiles.map((file: any) => ({
                          id: typeof file?.id === "string" ? file.id.trim() : "",
                          title: typeof file?.title === "string" ? file.title.trim() : "",
                          url: typeof file?.url === "string" ? file.url.trim() : "",
                          fileType: typeof file?.fileType === "string" ? file.fileType.trim() : "pdf"
                        }))
                      : [],
                    videos: Array.isArray(subAcquis?.videos)
                      ? subAcquis.videos.map((video: any) => ({
                          id: typeof video?.id === "string" ? video.id.trim() : "",
                          title: typeof video?.title === "string" ? video.title.trim() : "",
                          url: typeof video?.url === "string" ? video.url.trim() : "",
                          source: typeof video?.source === "string" ? video.source.trim() : "external"
                        }))
                      : [],
                    quizzes: Array.isArray(subAcquis?.quizzes)
                      ? subAcquis.quizzes.map((quiz: any) => ({
                          id: typeof quiz?.id === "string" ? quiz.id.trim() : "",
                          type: typeof quiz?.type === "string" ? quiz.type.trim() : "",
                          title: typeof quiz?.title === "string" ? quiz.title.trim() : "",
                          questions: Array.isArray(quiz?.questions)
                            ? quiz.questions.map((question: any) => ({
                                prompt: typeof question?.prompt === "string" ? question.prompt.trim() : "",
                                options: Array.isArray(question?.options)
                                  ? question.options.map((option: any) => String(option || "").trim()).filter(Boolean)
                                  : [],
                                correctAnswerIndex:
                                  typeof question?.correctAnswerIndex === "number"
                                    ? question.correctAnswerIndex
                                    : null
                              }))
                            : []
                        }))
                      : []
                  }))
                : []
            }))
          : []
      }))
      .filter((module: { id: string; name: string }) => module.id && module.name);

    if (!normalizedModules.length) {
      return res.status(400).json({ message: "Aucun module valide a enregistrer" });
    }

    await savePersistedCurriculumModules(normalizedModules as CurriculumModuleDoc[]);
    res.status(200).json({ modules: normalizedModules });
  } catch (error) {
    console.error("Failed to save backoffice curriculum:", error);
    res.status(500).json({ message: "Impossible d'enregistrer le curriculum" });
  }
});


