/**
 * prediction.routes.ts
 *
 * Risk/grade prediction, ML predict and the student dashboard.
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

export const predictionRouter = Router();

function listPredictionModules(moduleDocs: any[]): PredictionModuleInfo[] {
  return moduleDocs
    .filter((m) => m?.id && m?.name)
    .map((m) => {
      const acquisList = Array.isArray(m.acquis) ? m.acquis : [];
      const subAcquisCount = acquisList.reduce(
        (acc: number, ac: any) => acc + (Array.isArray(ac.sousAcquis) ? ac.sousAcquis.length : 0),
        0
      );
      return { id: String(m.id), name: String(m.name), subAcquisCount };
    })
    .filter((m) => m.subAcquisCount > 0);
}

/** Picks the module the student is most active in (default for the dashboard selector). */
function pickDefaultPredictionModule(
  modules: PredictionModuleInfo[],
  completedLessonKeys: string[],
  quizResults: Array<{ moduleId?: unknown }>
): PredictionModuleInfo | null {
  if (!modules.length) return null;
  const activity = new Map<string, number>();
  for (const key of completedLessonKeys) {
    const mid = String(key).split("::")[0];
    if (mid) activity.set(mid, (activity.get(mid) || 0) + 1);
  }
  for (const quiz of quizResults) {
    const mid = String((quiz as any)?.moduleId || "");
    if (mid) activity.set(mid, (activity.get(mid) || 0) + 0.5);
  }
  return [...modules].sort((a, b) => (activity.get(b.id) || 0) - (activity.get(a.id) || 0))[0];
}

/**
 * Computes a module-scoped risk + grade prediction (features restricted to one
 * module's lessons/quizzes). Shared by the dashboard and the prediction endpoint
 * so the two never diverge. When no requested module is valid, the student's
 * most-active module is used.
 */
async function buildModuleScopedPrediction(params: {
  progress: any;
  profile: any;
  scheduleStartDate: Date | null;
  modules: PredictionModuleInfo[];
  requestedModuleId?: string;
}) {
  const { progress, profile, scheduleStartDate, modules, requestedModuleId } = params;
  const completedLessonKeys: string[] = Array.isArray(progress?.completedLessonKeys)
    ? progress.completedLessonKeys.filter((k: unknown): k is string => typeof k === "string")
    : [];
  const quizResults = Array.isArray(progress?.quizResults) ? progress.quizResults : [];

  const requested = requestedModuleId ? modules.find((m) => m.id === requestedModuleId) : null;
  const target = requested || pickDefaultPredictionModule(modules, completedLessonKeys, quizResults);

  const features = extractMLFeatures({
    progress,
    profile,
    totalSubAcquis: target ? Math.max(target.subAcquisCount, 1) : 42,
    scheduleStartDate,
    moduleId: target?.id
  });

  // One call to the Python service returns the prediction and its SHAP explanation.
  const explanation = await resolveRiskExplanation(features);
  const catchupProbability = explanation.catchupProbability;
  const predictedGrade = explanation.predictedGrade;

  return {
    moduleId: target?.id ?? null,
    moduleName: target?.name ?? null,
    modules: modules.map((m) => ({ id: m.id, name: m.name })),
    catchupProbability,
    probabilityPct: Math.round(catchupProbability * 100),
    predictedGrade,
    features,
    riskFactors: explanation.riskFactors,
    shapValues: explanation.shapValues,
    gradeShapValues: explanation.gradeShapValues,
    gradeFactors: explanation.gradeFactors,
    explainSource: explanation.explainSource
  };
}

predictionRouter.get("/api/student/prediction/:identifier", requireAuth, async (req, res) => {
  try {
    // The verified session identity, never the URL param: this is a student's own
    // risk/grade prediction, so req.params.identifier must never be trusted to
    // pick whose data comes back (that was an IDOR — anyone logged in could read
    // any other student's prediction just by changing the URL).
    const identifier = req.auth?.id ?? "";
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }

    const requestedModuleId = typeof req.query.moduleId === "string" ? req.query.moduleId.trim() : undefined;

    const [user, profile, moduleDocs] = await Promise.all([
      User.findOne({ identifier }).select({ identifier: 1, progress: 1 }).lean(),
      StudentProfile.findOne({ identifier }).select({ loginCount: 1, lastLoginDate: 1, createdAt: 1, classId: 1 }).lean(),
      CurriculumModule.find().select({ id: 1, name: 1, acquis: 1, sortOrder: 1 }).sort({ sortOrder: 1 }).lean()
    ]);

    if (!user) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    let scheduleStartDate: Date | null = null;
    if ((profile as any)?.classId) {
      const classRoom = await ClassRoom.findById((profile as any).classId).select({ scheduleStartDate: 1 }).lean();
      scheduleStartDate = (classRoom as any)?.scheduleStartDate || null;
    }

    const scoped = await buildModuleScopedPrediction({
      progress: (user as any).progress,
      profile: profile as any,
      scheduleStartDate,
      modules: listPredictionModules(moduleDocs as any[]),
      requestedModuleId
    });

    res.status(200).json({ identifier, ...scoped });
  } catch (error) {
    console.error("Failed to compute prediction:", error);
    res.status(500).json({ message: "Impossible de calculer la prédiction" });
  }
});

// ---------------------------------------------------------------------------
// ML Predictor — direct feature input endpoint (used by the test UI)
// ---------------------------------------------------------------------------
predictionRouter.post("/api/ml/predict", async (req, res) => {
  try {
    const body = req.body ?? {};
    const parsed = {
      delayWeeks:     Number(body.delayWeeks),
      averageScore:   Number(body.averageScore),
      loginFrequency: Number(body.loginFrequency),
      gapDepth:       Number(body.gapDepth),
      // Newer features default to neutral values so older 5-feature callers still work.
      recencyRatio:   Number.isFinite(Number(body.recencyRatio)) ? Number(body.recencyRatio) : 0.5,
      weakSkillRatio: Number.isFinite(Number(body.weakSkillRatio)) ? Number(body.weakSkillRatio) : 0,
      // Attention: a caller that says nothing about focus is a student with no
      // attention data, not a student with average focus. Never impute a score.
      avgFocusScore:  Number.isFinite(Number(body.avgFocusScore)) ? Number(body.avgFocusScore) : 0,
      hasAttentionData: Number.isFinite(Number(body.avgFocusScore)) ? 1 : 0,
    };

    for (const key of ["delayWeeks", "averageScore", "loginFrequency", "gapDepth"] as const) {
      if (!Number.isFinite(parsed[key])) {
        return res.status(400).json({ message: `Invalid value for "${key}": must be a number.` });
      }
    }

    const explanation = await resolveRiskExplanation(parsed);

    return res.status(200).json({
      probability: explanation.catchupProbability,
      modelReady: MLPredictorService.isReady(),
      predictedGrade: explanation.predictedGrade,
      features: parsed,
      riskFactors: explanation.riskFactors,
      shapValues: explanation.shapValues,
      gradeShapValues: explanation.gradeShapValues,
      gradeFactors: explanation.gradeFactors,
      explainSource: explanation.explainSource
    });
  } catch (err) {
    console.error("[ML] /api/ml/predict error:", err);
    return res.status(500).json({ message: "Prediction failed." });
  }
});


// ---------------------------------------------------------------------------
// Dashboard — comprehensive student dashboard data
// ---------------------------------------------------------------------------
predictionRouter.get("/api/student/dashboard/:identifier", requireAuth, async (req, res) => {
  try {
    // Same IDOR concern as /api/student/prediction above: trust the session, not
    // the URL param, since this is the full dashboard payload for one student.
    const identifier = req.auth?.id ?? "";
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }

    const [user, profile, modulesRaw] = await Promise.all([
      User.findOne({ identifier }).select({ identifier: 1, progress: 1, createdAt: 1 }).lean(),
      StudentProfile.findOne({ identifier }).lean(),
      CurriculumModule.find().sort({ sortOrder: 1 }).lean()
    ]);

    if (!user) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const progress = (user as any).progress || {};
    const completedLessonKeys: string[] = Array.isArray(progress.completedLessonKeys)
      ? progress.completedLessonKeys.filter((k: unknown): k is string => typeof k === "string")
      : [];

    const quizResults: Array<{ moduleId: string; subAcquisId: string; score: number; submittedAt: string | null }> =
      Array.isArray(progress.quizResults)
        ? progress.quizResults
            .map((entry: any) => {
              const mid = String(entry?.moduleId || "");
              const sid = String(entry?.subAcquisId || "");
              const score = Number(entry?.score);
              const at = entry?.submittedAt ? new Date(String(entry.submittedAt)).toISOString() : null;
              if (!mid || !sid || !Number.isFinite(score)) return null;
              return { moduleId: mid, subAcquisId: sid, score, submittedAt: at };
            })
            .filter(Boolean)
        : [];

    const selfEvalResults: Array<{ moduleId: string; acquisId: string; score: number; passed: boolean; submittedAt: string | null }> =
      Array.isArray(progress.selfEvaluationResults)
        ? progress.selfEvaluationResults
            .map((entry: any) => ({
              moduleId: String(entry?.moduleId || ""),
              acquisId: String(entry?.acquisId || ""),
              score: Number(entry?.score || 0),
              passed: Boolean(entry?.passed),
              submittedAt: entry?.submittedAt ? new Date(String(entry.submittedAt)).toISOString() : null
            }))
            .filter((e: any) => e.moduleId && e.acquisId)
        : [];

    // Build stats
    const stats = computeStudentProgress({ completedLessonKeys, quizResults });

    // Build module overview
    const completedSet = new Set(completedLessonKeys);
    const latestQuizMap = new Map<string, { score: number; submittedAt: string | null }>();
    quizResults.forEach((qr) => {
      const key = `${qr.moduleId}::${qr.subAcquisId}`;
      const existing = latestQuizMap.get(key);
      if (!existing || (qr.submittedAt && existing.submittedAt && qr.submittedAt > existing.submittedAt)) {
        latestQuizMap.set(key, { score: qr.score, submittedAt: qr.submittedAt });
      }
    });

    const totalSubAcquis = modulesRaw.reduce((acc, m) => {
      const acquisList = Array.isArray((m as any).acquis) ? (m as any).acquis : [];
      return acc + acquisList.reduce((a2: number, ac: any) => a2 + (Array.isArray(ac.sousAcquis) ? ac.sousAcquis.length : 0), 0);
    }, 0);

    const overview = modulesRaw
      .filter((m: any) => m.id && m.name)
      .map((m: any) => {
        const acquisList = Array.isArray(m.acquis) ? m.acquis : [];
        const allSousAcquis: Array<{ id: string; name: string; hasQuiz: boolean; hasVideo: boolean }> = [];
        acquisList.forEach((ac: any) => {
          if (Array.isArray(ac.sousAcquis)) {
            ac.sousAcquis.forEach((sa: any) => {
              allSousAcquis.push({
                id: String(sa.id || ""),
                name: String(sa.name || sa.id || ""),
                hasQuiz: Array.isArray(sa.quizzes) && sa.quizzes.length > 0,
                hasVideo: Array.isArray(sa.videos) && sa.videos.length > 0
              });
            });
          }
        });
        const completedCount = allSousAcquis.filter((sa) => completedSet.has(`${m.id}::${sa.id}`)).length;
        return {
          id: String(m.id),
          name: m.name,
          sortOrder: Number(m.sortOrder) || 0,
          subAcquisCount: allSousAcquis.length,
          completedCount,
          progressPct: allSousAcquis.length > 0 ? Math.round((completedCount / allSousAcquis.length) * 100) : 0,
          subAcquis: allSousAcquis.map((sa) => {
            const key = `${m.id}::${sa.id}`;
            const quiz = latestQuizMap.get(key);
            return {
              ...sa,
              completed: completedSet.has(key),
              quizScore: quiz?.score ?? null,
              quizSubmittedAt: quiz?.submittedAt ?? null
            };
          })
        };
      });

    // ML Prediction
    let predictionScheduleStart: Date | null = null;
    if ((profile as any)?.classId) {
      const classRoom = await ClassRoom.findById((profile as any).classId).select({ scheduleStartDate: 1 }).lean();
      predictionScheduleStart = (classRoom as any)?.scheduleStartDate || null;
    }
    const scopedPrediction = await buildModuleScopedPrediction({
      // attentionSessions must be carried through: without it the dashboard's
      // prediction would read every student as having no attention data.
      progress: {
        completedLessonKeys,
        quizResults,
        selfEvaluationResults: selfEvalResults as any,
        attentionSessions: Array.isArray(progress.attentionSessions) ? progress.attentionSessions : []
      },
      profile: profile as any,
      scheduleStartDate: predictionScheduleStart,
      modules: listPredictionModules(modulesRaw as any[]),
      requestedModuleId: typeof req.query.moduleId === "string" ? req.query.moduleId.trim() : undefined
    });
    const catchupProbability = scopedPrediction.catchupProbability;

    // Global (all-modules) activity metrics for the hero badges / insights —
    // login frequency and pace are program-wide, unlike the scoped prediction.
    const globalFeatures = extractMLFeatures({
      // attentionSessions must be carried through: without it the dashboard's
      // prediction would read every student as having no attention data.
      progress: {
        completedLessonKeys,
        quizResults,
        selfEvaluationResults: selfEvalResults as any,
        attentionSessions: Array.isArray(progress.attentionSessions) ? progress.attentionSessions : []
      },
      profile: profile as any,
      totalSubAcquis: Math.max(totalSubAcquis, 1),
      scheduleStartDate: predictionScheduleStart
    });

    // Calendar
    let calendar: any[] = [];
    try {
      const accessData = await readClassAccessByStudentIdentifier(identifier);
      if (accessData) {
        const cal = toStudentCalendarEntries(
          modulesRaw.map((m: any) => ({
            id: String(m.id),
            name: m.name,
            sortOrder: Number(m.sortOrder) || 0,
            subAcquisCount: 0,
            subAcquis: (Array.isArray((m as any).acquis) ? (m as any).acquis : []).flatMap(
              (ac: any) => Array.isArray(ac.sousAcquis) ? ac.sousAcquis.map((sa: any) => ({
                id: String(sa.id || ""),
                name: String(sa.name || sa.id || ""),
                hasQuiz: Array.isArray(sa.quizzes) && sa.quizzes.length > 0,
                hasVideo: Array.isArray(sa.videos) && sa.videos.length > 0
              })) : []
            )
          })),
          accessData
        );
        calendar = cal || [];
      }
    } catch (_e) { /* calendar is optional */ }

    // Next uncompleted item
    let nextStep: { moduleId: string; moduleName: string; subAcquisId: string; subAcquisName: string } | null = null;
    for (const m of overview) {
      for (const sa of m.subAcquis) {
        if (!sa.completed) {
          nextStep = { moduleId: m.id, moduleName: m.name, subAcquisId: sa.id, subAcquisName: sa.name };
          break;
        }
      }
      if (nextStep) break;
    }

    // Weakest modules (recommendations)
    const weakestModules = [...overview]
      .filter((m) => m.subAcquisCount > 0)
      .sort((a, b) => a.progressPct - b.progressPct)
      .slice(0, 3)
      .map((m) => ({ id: m.id, name: m.name, progressPct: m.progressPct }));

    // Quiz score trend over time
    const quizTrend = quizResults
      .filter((qr) => qr.submittedAt)
      .sort((a, b) => new Date(String(a.submittedAt)).getTime() - new Date(String(b.submittedAt)).getTime())
      .slice(-30)
      .map((qr) => ({
        date: qr.submittedAt ? new Date(String(qr.submittedAt)).toISOString().slice(0, 10) : "",
        score: qr.score,
        moduleId: qr.moduleId,
        subAcquisId: qr.subAcquisId
      }));

    // Weekly activity (approximate from quiz submissions and lesson completions)
    const weeklyActivity: Array<{ week: string; lessons: number; quizzes: number }> = [];
    const weekMap = new Map<string, { lessons: number; quizzes: number }>();
    completedLessonKeys.forEach((key) => {
      // We don't have timestamps for lesson completion, so skip
    });
    quizResults.forEach((qr) => {
      if (!qr.submittedAt) return;
      const date = new Date(String(qr.submittedAt));
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const weekKey = weekStart.toISOString().slice(0, 10);
      const entry = weekMap.get(weekKey) || { lessons: 0, quizzes: 0 };
      entry.quizzes += 1;
      weekMap.set(weekKey, entry);
    });
    weekMap.forEach((val, key) => weeklyActivity.push({ week: key, ...val }));
    weeklyActivity.sort((a, b) => a.week.localeCompare(b.week));

    // Achievements
    const achievements: Array<{ id: string; title: string; description: string; icon: string; earned: boolean; progress: number; max: number }> = [
      { id: "first-lesson", title: "Premier pas", description: "Completez votre premiere lecon", icon: "", earned: stats.lessonsCompleted >= 1, progress: Math.min(stats.lessonsCompleted, 1), max: 1 },
      { id: "ten-lessons", title: "Apprenti", description: "Completez 10 lecons", icon: "", earned: stats.lessonsCompleted >= 10, progress: Math.min(stats.lessonsCompleted, 10), max: 10 },
      { id: "quiz-master", title: "Maitre du quiz", description: "Reussissez 10 quiz", icon: "", earned: stats.quizzesPassed >= 10, progress: Math.min(stats.quizzesPassed, 10), max: 10 },
      { id: "all-modules", title: "Explorateur", description: "Visitez tous les modules", icon: "", earned: overview.filter((m) => m.completedCount > 0).length >= overview.length, progress: overview.filter((m) => m.completedCount > 0).length, max: Math.max(overview.length, 1) },
      { id: "perfect-score", title: "Sans faute", description: "Obtenez 100% a un quiz", icon: "", earned: quizResults.some((qr) => qr.score >= 95), progress: quizResults.filter((qr) => qr.score >= 95).length > 0 ? 1 : 0, max: 1 },
      { id: "streak-7", title: "Regulier", description: "Connectez-vous 7 jours", icon: "", earned: Number(profile?.loginCount || 0) >= 7, progress: Math.min(Number(profile?.loginCount || 0), 7), max: 7 },
    ];

    // Study insights
    const avgQuizScore = stats.quizzesPassed > 0
      ? quizResults.reduce((s, q) => s + q.score, 0) / quizResults.length
      : 0;

    const bestModule = overview.length > 0 ? [...overview].sort((a, b) => b.progressPct - a.progressPct)[0] : null;
    const worstModule = overview.length > 0 ? [...overview].sort((a, b) => a.progressPct - b.progressPct)[0] : null;

    const insights = {
      totalQuizAttempts: quizResults.length,
      averageQuizScore: Math.round(avgQuizScore * 10) / 10,
      bestModule: bestModule ? { id: bestModule.id, name: bestModule.name, progressPct: bestModule.progressPct } : null,
      worstModule: worstModule ? { id: worstModule.id, name: worstModule.name, progressPct: worstModule.progressPct } : null,
      loginFrequency: globalFeatures.loginFrequency,
      xp: Number(progress.xp || 0),
      streak: Math.min(Number(profile?.loginCount || 0), 30),
      totalLessons: stats.lessonsCompleted,
      totalQuizzes: stats.quizzesPassed
    };

    // Content type the student is most attentive at (video / reading / quiz),
    // aggregated from attention sessions' per-content focus.
    const attnSessions: any[] = Array.isArray(progress.attentionSessions) ? progress.attentionSessions : [];
    const contentBuckets: Record<string, number[]> = { video: [], reading: [], quiz: [] };
    for (const s of attnSessions) {
      const fbc = (s && s.focusByContent) || {};
      if (Number.isFinite(Number(fbc.video))) contentBuckets.video.push(Number(fbc.video));
      if (Number.isFinite(Number(fbc.support))) contentBuckets.reading.push(Number(fbc.support));
      if (Number.isFinite(Number(fbc.quiz))) contentBuckets.quiz.push(Number(fbc.quiz));
      else if (s && s.context === "quiz" && Number.isFinite(Number(s.avgFocusScore))) contentBuckets.quiz.push(Number(s.avgFocusScore));
    }
    const contentAverages = Object.entries(contentBuckets)
      .filter(([, arr]) => arr.length > 0)
      .map(([type, arr]) => ({ type, score: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) }));
    const mostAttentiveContent = contentAverages.length
      ? contentAverages.sort((a, b) => b.score - a.score)[0]
      : null;

    res.status(200).json({
      identifier,
      mostAttentiveContent,
      profile: profile ? {
        fullName: (profile as any).fullName,
        email: (profile as any).email,
        xp: insights.xp,
        loginCount: Number(profile?.loginCount || 0),
        lastLoginDate: (profile as any)?.lastLoginDate || null,
        streak: insights.streak
      } : null,
      progress: stats,
      overview,
      prediction: {
        catchupProbability: scopedPrediction.catchupProbability,
        probabilityPct: scopedPrediction.probabilityPct,
        predictedGrade: scopedPrediction.predictedGrade,
        moduleId: scopedPrediction.moduleId,
        moduleName: scopedPrediction.moduleName,
        modules: scopedPrediction.modules,
        features: scopedPrediction.features,
        riskFactors: scopedPrediction.riskFactors,
        shapValues: scopedPrediction.shapValues,
        gradeShapValues: scopedPrediction.gradeShapValues,
        gradeFactors: scopedPrediction.gradeFactors,
        explainSource: scopedPrediction.explainSource
      },
      calendarEntries: calendar.slice(0, 8),
      nextStep,
      weakestModules,
      quizTrend,
      weeklyActivity,
      achievements,
      insights,
      totalSubAcquis
    });
  } catch (error) {
    console.error("Failed to load dashboard data:", error);
    res.status(500).json({ message: "Impossible de charger les données du tableau de bord" });
  }
});

