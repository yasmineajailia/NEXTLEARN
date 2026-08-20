/**
 * learning.routes.ts
 *
 * Sub-acquis content, calendar, progress and VARK.
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
  SESSION_TTL,
  TeacherQuizGenerationSession,
  applyCurriculumNames,
  buildCourseFileEntries,
  buildCurriculumSeedFromFilesystem,
  buildRemediationQuizJsonFilePath,
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
  findFirstDirectoryByName,
  generateSessionId,
  generatedQuizzesRoot,
  hasActiveRemediationQuiz,
  hasMissingFilesystemCurriculumEntries,
  hasRenderableCurriculum,
  listSubAcquisIds,
  loadRecommendationGraph,
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
  subAcquisHasQuiz,
  subAcquisHasVideo,
  supportPublicPrefix,
  supportRoot,
  teacherQuizSessions,
  toCurriculumQuestion,
  toPublicPath,
} from "./shared.js";

export const learningRouter = Router();

learningRouter.get<{ moduleId: string; subAcquisId: string }>("/api/programmation-c/sub-acquis/:moduleId/:subAcquisId", requireAuth, async (req, res) => {
  try {
    const { moduleId, subAcquisId } = req.params;
    const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
    const access = await readClassAccessByStudentIdentifier(identifier);

    if (!isSubAcquisAccessibleByAccessRules(access, moduleId, subAcquisId)) {
      return res.status(403).json({ message: "Sous-acquis non disponible pour le moment" });
    }

    const resources = await readPersistedSubAcquisResources(moduleId, subAcquisId);

    let remediationMeta: {
      isRemediation: boolean;
      remediationQuizId: string | null;
      retryNumber: number | null;
    } = {
      isRemediation: false,
      remediationQuizId: null,
      retryNumber: null
    };

    let publicQuestions = resources.quizQuestions.map((question) => ({
      prompt: question.prompt,
      options: question.options
    }));

    if (identifier) {
      const activeRemediation = await StudentRemediationQuiz.findOne({
        identifier,
        moduleId,
        subAcquisId,
        status: "active"
      })
        .sort({ createdAt: -1 })
        .lean();

      if (activeRemediation) {
        const expired =
          activeRemediation.expiresAt instanceof Date && activeRemediation.expiresAt.getTime() <= Date.now();

        if (expired) {
          await StudentRemediationQuiz.updateOne(
            { _id: activeRemediation._id },
            { $set: { status: "expired" } }
          );
        } else if (Array.isArray(activeRemediation.questions) && activeRemediation.questions.length > 0) {
          publicQuestions = activeRemediation.questions.map((question) => ({
            prompt: question.prompt,
            options: question.options
          }));

          remediationMeta = {
            isRemediation: true,
            remediationQuizId: String(activeRemediation._id),
            retryNumber: Number(activeRemediation.retryNumber || 1)
          };
        }
      }
    }

    const quizState = await readQuizAttemptState(
      identifier,
      buildLessonKey(moduleId, subAcquisId),
      remediationMeta.isRemediation
    );

    res.status(200).json({
      moduleId,
      subAcquisId,
      moduleName: resources.moduleName,
      acquisName: resources.acquisName,
      subAcquisName: resources.subAcquisName,
      courseFiles: resources.pptFiles,
      videoFiles: resources.videoFiles,
      quizQuestions: publicQuestions,
      quizQuestionCount: publicQuestions.length,
      quizState,
      ...remediationMeta
    });
  } catch (error) {
    console.error("Failed to read sub-acquis resources:", error);
    res.status(404).json({ message: "Sous-acquis introuvable" });
  }
});

learningRouter.get("/api/student/calendar", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }

    const [overview, access] = await Promise.all([
      readPersistedProgramCOverview(),
      readClassAccessByStudentIdentifier(identifier)
    ]);

    const calendar = toStudentCalendarEntries(overview, access);
    res.status(200).json({
      classId: access?.classId || "",
      startDate: access?.scheduleStartDate || null,
      calendar
    });
  } catch (error) {
    console.error("Failed to build student calendar:", error);
    res.status(500).json({ message: "Impossible de charger le calendrier" });
  }
});


// Quiz submission endpoint.
// Receives user answers and computes score from DOCX answer key.
learningRouter.post("/api/programmation-c/sub-acquis/:moduleId/:subAcquisId/submit", requireAuth, async (req, res) => {
  try {
    const moduleId = String(req.params.moduleId ?? "");
    const subAcquisId = String(req.params.subAcquisId ?? "");
    const rawAnswers: unknown[] = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const answers = rawAnswers.map((entry) => Number(entry));
    const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value

    if (identifier) {
      const access = await readClassAccessByStudentIdentifier(identifier);

      if (!isSubAcquisAccessibleByAccessRules(access, moduleId, subAcquisId)) {
        return res.status(403).json({ message: "Sous-acquis non disponible pour le moment" });
      }
    }

    const resources = await readPersistedSubAcquisResources(moduleId, subAcquisId);

    const total = resources.quizQuestions.length;
    if (total === 0) {
      return res.status(200).json({ total: 0, gradable: 0, correct: 0, score: 0 });
    }

    const gradableQuestions = resources.quizQuestions.filter(
      (question) => question.correctOptionIndex !== null
    );
    const gradable = gradableQuestions.length;

    const normalizeOptionText = (value: unknown): string =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    // Grade every question ONCE. The score, the wrong-question list, the review
    // payload and the captured attempt record all derive from this, so they can
    // never disagree about what "correct" means.
    const perQuestion = resources.quizQuestions.map((question, index) => {
      const correctIndex =
        typeof question.correctOptionIndex === "number" ? question.correctOptionIndex : null;
      const selected = Number(answers[index]);
      const selectedIndex = Number.isFinite(selected) ? selected : -1;
      if (correctIndex === null) {
        return { gradable: false, correct: false, selectedIndex, correctIndex: null, isCorrectByText: false };
      }
      const selectedOption = Number.isFinite(selected) ? question.options[selected] : null;
      const correctOption = question.options[correctIndex] ?? null;
      const isCorrectByIndex = selected === correctIndex;
      const isCorrectByText =
        !isCorrectByIndex &&
        selectedOption !== null &&
        correctOption !== null &&
        normalizeOptionText(selectedOption) === normalizeOptionText(correctOption);
      return {
        gradable: true,
        correct: isCorrectByIndex || isCorrectByText,
        selectedIndex,
        correctIndex,
        isCorrectByText
      };
    });

    const correct = perQuestion.reduce((sum, q) => (q.gradable && q.correct ? sum + 1 : sum), 0);

    const wrongQuestionIndexes = perQuestion
      .map((q, index) => (q.gradable && !q.correct ? index : -1))
      .filter((index) => index >= 0);

    const score = gradable > 0 ? Math.round((correct / gradable) * 100) : 0;
    const passed = gradable === 0 ? true : correct === gradable;
    const validated = gradable === 0 ? true : score >= QUIZ_PASS_SCORE;

    let attemptState: QuizAttemptState = {
      attempts: 0,
      attemptsRemaining: QUIZ_MAX_ATTEMPTS,
      locked: false,
      validated,
      lastScore: score
    };
    let xpEarned = 0;

    if (identifier) {
      const lessonKey = buildLessonKey(moduleId, subAcquisId);
      const activeRemediation = await hasActiveRemediationQuiz(identifier, moduleId, subAcquisId);
      const priorState = await readQuizAttemptState(identifier, lessonKey, activeRemediation);

      // Reject submissions once the base quiz is locked (validated or out of
      // attempts) — this closes the page-reload bypass. Remediation retries are
      // exempt (priorState.locked is false while a remediation is active).
      if (priorState.locked) {
        return res.status(409).json({
          message: priorState.validated
            ? "Ce quiz est déjà validé."
            : "Nombre maximal de tentatives atteint.",
          locked: true,
          validated: priorState.validated,
          attempts: priorState.attempts,
          attemptsRemaining: 0,
          lastScore: priorState.lastScore
        });
      }

      // Remediation attempts don't count against the base-quiz limit.
      const newAttempts = activeRemediation ? priorState.attempts : priorState.attempts + 1;

      await User.updateOne(
        { identifier },
        {
          $addToSet: { "progress.completedLessonKeys": lessonKey },
          $pull: { "progress.quizResults": { lessonKey } }
        }
      );

      await User.updateOne(
        { identifier },
        {
          $push: {
            "progress.quizResults": {
              lessonKey,
              moduleId,
              subAcquisId,
              score,
              attempts: newAttempts,
              submittedAt: new Date()
            },
            // Append-only attempt history — the per-attempt SEQUENCE that
            // Knowledge Tracing (BKT) and item analysis (IRT) need, and that
            // quizResults throws away by $pull-ing the prior entry. Never
            // $pull-ed here; $slice caps it so the document stays bounded.
            // This data cannot be backfilled, so capture starts now.
            "progress.skillAttempts": {
              $each: [
                {
                  lessonKey,
                  moduleId,
                  subAcquisId,
                  score,
                  correct: validated,
                  attempts: newAttempts,
                  responses: perQuestion.map((q, index) => ({
                    questionIndex: index,
                    selectedIndex: q.selectedIndex,
                    correct: q.correct,
                    gradable: q.gradable
                  })),
                  submittedAt: new Date()
                }
              ],
              $slice: -200
            }
          }
        }
      );

      // XP is awarded once per sous-acquis, on the attempt that first validates it.
      // The `locked` guard above already rejects resubmitting a validated base
      // quiz, but remediation retries are exempt from that lock, so the explicit
      // `!priorState.validated` check is what stops a student re-earning XP by
      // passing the same sous-acquis again through remediation.
      if (validated && !priorState.validated) {
        xpEarned = Math.floor(score);
        await User.updateOne({ identifier }, { $inc: { "progress.xp": xpEarned } });
        await StudentProfile.updateOne({ identifier }, { $inc: { xp: xpEarned } });
      }

      const exhausted = newAttempts >= QUIZ_MAX_ATTEMPTS;
      attemptState = {
        attempts: newAttempts,
        attemptsRemaining: Math.max(0, QUIZ_MAX_ATTEMPTS - newAttempts),
        locked: !activeRemediation && (validated || exhausted),
        validated,
        lastScore: score
      };
    }

    const review = perQuestion.map((q) => ({
      selectedIndex: q.selectedIndex,
      correctOptionIndex: q.isCorrectByText ? q.selectedIndex : q.correctIndex
    }));

    // On a failed quiz, turn the wrong answers into a ranked list of sous-acquis
    // to review. Response-driven when questions are tagged; the failed sous-acquis's
    // prerequisites otherwise (so the panel is never empty). Computed here so the
    // client renders a definitive list instead of re-deriving it from the raw graph.
    let remediationTargets: RemediationTarget[] = [];
    if (!validated) {
      const graph = await loadRecommendationGraph();
      if (graph) {
        remediationTargets = computeRemediationTargets({
          failedSubAcquisId: subAcquisId,
          wrongQuestionIndexes,
          questionTags: resources.quizQuestions.map((q) => q.relatedSubAcquis ?? null),
          graph
        });
      }
    }

    res.status(200).json({
      total,
      gradable,
      correct,
      score,
      passed,
      validated,
      attempts: attemptState.attempts,
      attemptsRemaining: attemptState.attemptsRemaining,
      locked: attemptState.locked,
      wrongQuestionCount: wrongQuestionIndexes.length,
      wrongQuestionIndexes,
      review,
      remediationTargets,
      xpEarned
    });
  } catch (error) {
    console.error("Failed to score quiz:", error);
    res.status(400).json({ message: "Impossible de corriger le quiz" });
  }
});

learningRouter.post("/api/student/progress/lesson-view", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
    const moduleId = typeof req.body?.moduleId === "string" ? req.body.moduleId.trim() : "";
    const subAcquisId = typeof req.body?.subAcquisId === "string" ? req.body.subAcquisId.trim() : "";

    if (!identifier || !moduleId || !subAcquisId) {
      return res.status(400).json({ message: "identifier, moduleId et subAcquisId sont requis" });
    }

    const lessonKey = buildLessonKey(moduleId, subAcquisId);
    const updateResult = await User.updateOne(
      { identifier },
      { $addToSet: { "progress.completedLessonKeys": lessonKey } }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Failed to mark lesson as viewed:", error);
    res.status(500).json({ message: "Impossible d'enregistrer la progression" });
  }
});

const VARK_DOMINANTS = ["visual", "readwrite", "auditory", "kinesthetic"] as const;

// Persist the student's VARK learning-style result (server copy of the localStorage
// value). Identity comes from the verified session, never the request body.
learningRouter.post("/api/student/vark", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? "";
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }
    const existing = await User.findOne({ identifier }).select({ varkProfile: 1 }).lean();
    const existingProfile = (existing as { varkProfile?: { completedAt?: unknown } } | null)?.varkProfile;
    if (existingProfile?.completedAt) {
      // One-shot by design: the VARK result gates first access to the platform, so it
      // must not be retakeable/overwritable once recorded.
      return res.status(409).json({ message: "Le test VARK a déjà été complété", varkProfile: existingProfile });
    }
    const dominant = typeof req.body?.dominant === "string" ? req.body.dominant.trim() : "";
    if (!VARK_DOMINANTS.includes(dominant as (typeof VARK_DOMINANTS)[number])) {
      return res.status(400).json({ message: "dominant invalide" });
    }
    const rawScores =
      req.body?.scores && typeof req.body.scores === "object" ? (req.body.scores as Record<string, unknown>) : {};
    const clampScore = (value: unknown): number => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    const scores = {
      visual: clampScore(rawScores.visual),
      readwrite: clampScore(rawScores.readwrite),
      auditory: clampScore(rawScores.auditory),
      kinesthetic: clampScore(rawScores.kinesthetic)
    };
    const updateResult = await User.updateOne(
      { identifier },
      { $set: { varkProfile: { dominant, scores, completedAt: new Date() } } }
    );
    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Failed to save VARK profile:", error);
    res.status(500).json({ message: "Impossible d'enregistrer le profil VARK" });
  }
});

// Read the student's own persisted VARK profile (used to hydrate the client when
// localStorage is empty, e.g. on a new device).
learningRouter.get("/api/student/vark", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? "";
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }
    const user = await User.findOne({ identifier }).select({ varkProfile: 1 }).lean();
    res.status(200).json({ varkProfile: (user as { varkProfile?: unknown } | null)?.varkProfile ?? null });
  } catch (error) {
    console.error("Failed to read VARK profile:", error);
    res.status(500).json({ message: "Impossible de lire le profil VARK" });
  }
});

// Classical item analysis for one quiz (teacher/admin only). Gathers each student's
// FIRST attempt's gradable responses and asks the Python ML service for per-question
// difficulty + discrimination + KR-20 reliability, then labels each item with its
// prompt so a teacher can see which AI-generated questions are broken / too easy /
// too hard. requireRole guards it directly (learningRouter runs before the /api/backoffice
// role guard in server.ts).
learningRouter.get(
  "/api/backoffice/item-analysis/:moduleId/:subAcquisId",
  requireRole("enseignant", "admin"),
  async (req, res) => {
    try {
      const moduleId = String(req.params.moduleId ?? "");
      const subAcquisId = String(req.params.subAcquisId ?? "");
      if (!moduleId || !subAcquisId) {
        return res.status(400).json({ message: "moduleId et subAcquisId sont requis" });
      }

      const users = await User.find({
        "progress.skillAttempts": { $elemMatch: { moduleId, subAcquisId } }
      })
        .select({ "progress.skillAttempts": 1 })
        .lean();

      type StoredAttempt = {
        moduleId?: string;
        subAcquisId?: string;
        submittedAt?: Date | string;
        responses?: Array<{ questionIndex?: number; correct?: boolean; gradable?: boolean }>;
      };

      const attempts: ItemAttempt[] = [];
      for (const user of users) {
        const skillAttempts = (user as { progress?: { skillAttempts?: StoredAttempt[] } }).progress?.skillAttempts;
        if (!Array.isArray(skillAttempts)) continue;
        // First attempt per student = item difficulty on first exposure (no learning effect).
        const forQuiz = skillAttempts
          .filter((a) => a && a.moduleId === moduleId && a.subAcquisId === subAcquisId && Array.isArray(a.responses))
          .sort((a, b) => new Date(a.submittedAt || 0).getTime() - new Date(b.submittedAt || 0).getTime());
        if (!forQuiz.length) continue;
        const first = forQuiz[0];
        attempts.push({
          responses: (first.responses ?? []).map((r) => ({
            questionIndex: Number(r.questionIndex ?? -1),
            correct: !!r.correct,
            gradable: r.gradable !== false
          }))
        });
      }

      const analysis = await computeItemAnalysis(attempts);

      // Best-effort: label each item with its question prompt (by index).
      const resources = await readPersistedSubAcquisResources(moduleId, subAcquisId).catch(() => null);
      const questions = (resources?.quizQuestions ?? []) as Array<{ prompt?: string }>;
      const items = analysis.items.map((item) => ({
        ...item,
        prompt: questions[item.questionIndex]?.prompt ?? null
      }));

      return res.status(200).json({ moduleId, subAcquisId, items, summary: analysis.summary });
    } catch (error) {
      console.error("Failed to compute item analysis:", error);
      return res.status(500).json({ message: "Impossible de calculer l'analyse des questions" });
    }
  }
);

learningRouter.get("/api/student/progress/:identifier", requireAuth, async (req, res) => {
  try {
    // Verified session identity, never the URL param — same IDOR class as the
    // prediction/dashboard routes: this returns one student's full progress
    // (quiz history, completed lessons), so it must never be readable for an
    // identifier other than the caller's own.
    const identifier = req.auth?.id ?? "";
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }

    const user = await User.findOne({ identifier }).select({ identifier: 1, progress: 1 }).lean();
    if (!user) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const progressData = (user as {
      progress?: {
        xp?: number;
        completedLessonKeys?: unknown;
        quizResults?: Array<{
          lessonKey?: unknown;
          moduleId?: unknown;
          subAcquisId?: unknown;
          score?: unknown;
          submittedAt?: unknown;
        }>;
      };
    }).progress;

    const completedLessonKeys = Array.isArray(progressData?.completedLessonKeys)
      ? progressData.completedLessonKeys.filter((entry): entry is string => typeof entry === "string")
      : [];

    const quizResults = Array.isArray(progressData?.quizResults)
      ? progressData.quizResults
          .map((entry) => {
            const lessonKey = typeof entry?.lessonKey === "string" ? entry.lessonKey : "";
            const moduleId = typeof entry?.moduleId === "string" ? entry.moduleId : "";
            const subAcquisId = typeof entry?.subAcquisId === "string" ? entry.subAcquisId : "";
            const score = Number(entry?.score);
            const submittedAt = entry?.submittedAt ? new Date(String(entry.submittedAt)).toISOString() : null;

            if (!lessonKey || !moduleId || !subAcquisId || !Number.isFinite(score)) {
              return null;
            }

            return {
              lessonKey,
              moduleId,
              subAcquisId,
              score,
              submittedAt
            };
          })
          .filter(
            (
              entry
            ): entry is {
              lessonKey: string;
              moduleId: string;
              subAcquisId: string;
              score: number;
              submittedAt: string | null;
            } => Boolean(entry)
          )
      : [];

    const stats = computeStudentProgress({
      completedLessonKeys,
      quizResults: quizResults.map((entry) => ({ score: entry.score }))
    });

    res.status(200).json({
      identifier,
      xp: progressData?.xp || 0,
      lessonsCompleted: stats.lessonsCompleted,
      quizzesPassed: stats.quizzesPassed,
      averageQuizScoreOn20: stats.averageQuizScoreOn20,
      completedLessonKeys,
      quizResults
    });
  } catch (error) {
    console.error("Failed to load student progression:", error);
    res.status(500).json({ message: "Impossible de charger la progression" });
  }
});


