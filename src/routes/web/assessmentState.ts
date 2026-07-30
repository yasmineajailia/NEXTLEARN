/**
 * routes/web/assessmentState.ts
 *
 * Everything about a student's assessment/recommendation STATE, as opposed to
 * curriculum content itself (see curriculumContent.ts, the other half of the
 * former 1946-line shared.ts): the recommendation-graph cache, the in-memory
 * teacher quiz-generation session store, remediation-quiz attempt state, and
 * self-evaluation scoring.
 *
 * Two module-level caches live here (recommendationGraphCache,
 * teacherQuizSessions) — deliberately kept in this ONE file rather than
 * duplicated, since a second copy in another file would silently become a
 * second, independent cache instead of the intended shared singleton.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { User } from "../../models/User";
import { StudentRemediationQuiz } from "../../models/StudentRemediationQuiz";
import type { ChapterScoreEntry, ScoreEntry, SkillsJson } from "../../services/recommendation/skill-recommender.js";
import type { TeacherGeneratedQuestion } from "../../services/quiz/quizGenClient";
import { generatedQuizzesRoot, sanitizePathSegment } from "./curriculumContent";
import type { CurriculumAcquis, CurriculumModuleDoc, QuizQuestion } from "../../types/curriculum";

export const recommendationGraphPath = path.join(process.cwd(), "data", "graph.json");
let recommendationGraphCache: SkillsJson | null = null;

export type RecommendationGraphNode = {
  title?: string;
  depends_on?: string[];
  unlocks?: string[];
};

export type RecommendationGraphPayload = {
  sub_skills?: Record<string, RecommendationGraphNode>;
};

export function normalizeRecommendationGraph(payload: unknown): SkillsJson | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const graphPayload = payload as RecommendationGraphPayload;
  const subSkills = graphPayload.sub_skills;
  if (!subSkills || typeof subSkills !== "object") {
    return null;
  }

  const normalized: SkillsJson = {};
  for (const [id, node] of Object.entries(subSkills)) {
    if (!node || typeof node !== "object") {
      continue;
    }

    normalized[id] = {
      title: String(node.title || id),
      depends_on: Array.isArray(node.depends_on)
        ? node.depends_on.filter((dep): dep is string => typeof dep === "string")
        : [],
      unlocks: Array.isArray(node.unlocks)
        ? node.unlocks.filter((unlockId): unlockId is string => typeof unlockId === "string")
        : []
    };
  }

  return Object.keys(normalized).length ? normalized : null;
}

export async function loadRecommendationGraph(): Promise<SkillsJson | null> {
  if (recommendationGraphCache) {
    return recommendationGraphCache;
  }

  try {
    const raw = await fs.readFile(recommendationGraphPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const graph = normalizeRecommendationGraph(parsed);
    recommendationGraphCache = graph;
    return graph;
  } catch (_error) {
    return null;
  }
}

export function pickRecommendationMode(body: any): "recommend" | "remediation" | "revisit" | "snapshot" | "report" {
  const mode = typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "";
  if (mode === "recommend" || mode === "remediation" || mode === "revisit" || mode === "snapshot" || mode === "report") {
    return mode;
  }

  return "snapshot";
}

export function parseCompletedIds(body: any): string[] {
  return Array.isArray(body?.completedIds)
    ? body.completedIds
        .filter((id: unknown): id is string => typeof id === "string" && Boolean(id.trim()))
        .map((id: string) => id.trim())
    : [];
}

export function parseSubSkillScores(body: any): ScoreEntry[] {
  return Array.isArray(body?.subSkillScores)
    ? body.subSkillScores
        .filter((entry: any) => typeof entry?.subSkillId === "string" && Number.isFinite(Number(entry?.score)))
        .map((entry: any) => ({
          subSkillId: String(entry.subSkillId).trim(),
          score: Number(entry.score)
        }))
    : [];
}

export function parseSkillScores(body: any): ChapterScoreEntry[] {
  return Array.isArray(body?.skillScores)
    ? body.skillScores
        .filter((entry: any) => typeof entry?.chapterId === "string" || typeof entry?.chapterId === "number")
        .filter((entry: any) => Number.isFinite(Number(entry?.score)))
        .map((entry: any) => ({
          chapterId: String(entry.chapterId).trim(),
          score: Number(entry.score)
        }))
    : [];
}

// ---------------------------------------------------------------------------
// Teacher AI quiz-generation sessions (in-memory, TTL'd).
// ---------------------------------------------------------------------------

export type TeacherQuizGenerationSession = {
  sessionId: string;
  moduleId: string;
  moduleName: string;
  subAcquisId: string;
  subAcquisName: string;
  topic: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  count: number;
  questions: TeacherGeneratedQuestion[];
  createdAt: Date;
};

export const teacherQuizSessions = new Map<string, TeacherQuizGenerationSession>();
export const SESSION_TTL = 3600000; // 1 hour in milliseconds

export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of teacherQuizSessions.entries()) {
    if (now - session.createdAt.getTime() > SESSION_TTL) {
      teacherQuizSessions.delete(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Remediation-quiz attempt state.
// ---------------------------------------------------------------------------

// Quiz attempt policy (kept in sync with the client in questionnaire.html):
// a student gets at most QUIZ_MAX_ATTEMPTS tries, and a score >= QUIZ_PASS_SCORE
// counts as validated. Once validated or out of attempts, the quiz is locked.
export const QUIZ_PASS_SCORE = 60;
export const QUIZ_MAX_ATTEMPTS = 2;

export type QuizAttemptState = {
  attempts: number;
  attemptsRemaining: number;
  locked: boolean;
  validated: boolean;
  lastScore: number | null;
};

/**
 * Reads a student's stored attempt state for one quiz. Remediation quizzes are
 * governed by their own lifecycle, so callers pass `hasActiveRemediation` to
 * keep the base-quiz attempt limit from locking a remediation retry.
 */
export async function readQuizAttemptState(
  identifier: string,
  lessonKey: string,
  hasActiveRemediation: boolean
): Promise<QuizAttemptState> {
  const fresh: QuizAttemptState = {
    attempts: 0,
    attemptsRemaining: QUIZ_MAX_ATTEMPTS,
    locked: false,
    validated: false,
    lastScore: null
  };

  if (!identifier) return fresh;

  const userDoc = await User.findOne({ identifier }, { "progress.quizResults": 1 }).lean();
  const prior = (userDoc?.progress?.quizResults || []).find(
    (entry: any) => entry.lessonKey === lessonKey
  );
  if (!prior) return fresh;

  const attempts = Number(prior.attempts || 1);
  const lastScore = Number(prior.score);
  const validated = Number.isFinite(lastScore) && lastScore >= QUIZ_PASS_SCORE;
  const exhausted = attempts >= QUIZ_MAX_ATTEMPTS;

  return {
    attempts,
    attemptsRemaining: Math.max(0, QUIZ_MAX_ATTEMPTS - attempts),
    // An active remediation quiz overrides the base-quiz lock so the student can retry it.
    locked: !hasActiveRemediation && (validated || exhausted),
    validated,
    lastScore: Number.isFinite(lastScore) ? lastScore : null
  };
}

/** True if the student has a non-expired, active remediation quiz for this sub-acquis. */
export async function hasActiveRemediationQuiz(
  identifier: string,
  moduleId: string,
  subAcquisId: string
): Promise<boolean> {
  if (!identifier) return false;
  const active = await StudentRemediationQuiz.findOne({
    identifier,
    moduleId,
    subAcquisId,
    status: "active"
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!active) return false;
  const expired = active.expiresAt instanceof Date && active.expiresAt.getTime() <= Date.now();
  return !expired && Array.isArray(active.questions) && active.questions.length > 0;
}

export function buildRemediationQuizJsonFilePath(params: {
  identifier: string;
  moduleId: string;
  subAcquisId: string;
  retryNumber: number;
  quizId: string;
}): { filePath: string; fileName: string } {
  const safeIdentifier = sanitizePathSegment(params.identifier);
  const safeModuleId = sanitizePathSegment(params.moduleId);
  const safeSubAcquisId = sanitizePathSegment(params.subAcquisId);
  const safeQuizId = sanitizePathSegment(params.quizId);
  const fileName = `remediation-${safeModuleId}-${safeSubAcquisId}-retry-${params.retryNumber}-${safeQuizId}.json`;

  return {
    fileName,
    filePath: path.join(generatedQuizzesRoot, safeIdentifier, safeModuleId, safeSubAcquisId, fileName)
  };
}

export async function saveRemediationQuizJsonFile(params: {
  filePath: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.filePath), { recursive: true });
  await fs.writeFile(params.filePath, `${JSON.stringify(params.payload, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Self-evaluation scoring.
// ---------------------------------------------------------------------------

export const SELF_EVALUATION_PASS_SCORE = 60;

export type SelfEvaluationResult = {
  moduleId: string;
  acquisId: string;
  score: number;
  passed: boolean;
  submittedAt?: Date;
};

export function makeSelfEvaluationKey(moduleId: string, acquisId: string): string {
  return `${moduleId}::${acquisId}`;
}

export function collectAcquisQuizQuestions(acquis: CurriculumAcquis): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  const subAcquisList = Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : [];

  subAcquisList.forEach((subAcquis) => {
    const quizzes = Array.isArray(subAcquis.quizzes) ? subAcquis.quizzes : [];
    quizzes.forEach((quiz) => {
      const quizQuestions = Array.isArray(quiz.questions) ? quiz.questions : [];
      quizQuestions.forEach((question) => {
        const prompt = String(question.prompt || "").trim();
        const options = Array.isArray(question.options)
          ? question.options.map((option) => String(option || "").trim()).filter(Boolean)
          : [];

        if (!prompt || options.length < 2) {
          return;
        }

        questions.push({
          prompt,
          options,
          correctOptionIndex:
            typeof question.correctAnswerIndex === "number" ? question.correctAnswerIndex : null
        });
      });
    });
  });

  return questions;
}

export function extractSelfEvaluationResults(user: { progress?: { selfEvaluationResults?: SelfEvaluationResult[] } } | null) {
  const resultMap = new Map<string, SelfEvaluationResult>();
  const stored = user?.progress?.selfEvaluationResults;
  if (!Array.isArray(stored)) {
    return resultMap;
  }

  stored.forEach((entry) => {
    const moduleId = String(entry?.moduleId || "").trim();
    const acquisId = String(entry?.acquisId || "").trim();
    if (!moduleId || !acquisId) {
      return;
    }

    resultMap.set(makeSelfEvaluationKey(moduleId, acquisId), {
      moduleId,
      acquisId,
      score: Number.isFinite(Number(entry?.score)) ? Number(entry?.score) : 0,
      passed: Boolean(entry?.passed),
      submittedAt: entry?.submittedAt ? new Date(entry.submittedAt) : undefined
    });
  });

  return resultMap;
}

export function buildSelfEvaluationOverview(
  modules: CurriculumModuleDoc[],
  resultsMap: Map<string, SelfEvaluationResult>
) {
  let canUnlockNext = true;

  return modules
    .map((moduleDoc) => {
      const moduleId = String(moduleDoc.id || "").trim();
      if (!moduleId) {
        return null;
      }

      const acquisList = Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : [];
      const availableAcquis = acquisList
        .map((acquis) => {
          const acquisId = String(acquis.id || "").trim();
          if (!acquisId) {
            return null;
          }

          const questions = collectAcquisQuizQuestions(acquis);
          if (!questions.length) {
            return null;
          }

          const key = makeSelfEvaluationKey(moduleId, acquisId);
          const result = resultsMap.get(key);

          return {
            acquisId,
            acquisName: acquis.name || acquisId,
            questionCount: questions.length,
            isPassed: Boolean(result?.passed),
            lastScore: typeof result?.score === "number" ? result.score : null,
            lastSubmittedAt: result?.submittedAt || null
          };
        })
        .filter(Boolean) as Array<{
        acquisId: string;
        acquisName: string;
        questionCount: number;
        isPassed: boolean;
        lastScore: number | null;
        lastSubmittedAt: Date | null;
      }>;

      if (!availableAcquis.length) {
        return null;
      }

      const acquis = availableAcquis.map((entry) => {
        const isUnlocked = canUnlockNext;
        canUnlockNext = isUnlocked && entry.isPassed;
        return { ...entry, isUnlocked };
      });

      return {
        moduleId,
        moduleName: moduleDoc.name || moduleId,
        acquis
      };
    })
    .filter(Boolean) as Array<{
    moduleId: string;
    moduleName: string;
    acquis: Array<{
      acquisId: string;
      acquisName: string;
      questionCount: number;
      isPassed: boolean;
      isUnlocked: boolean;
      lastScore: number | null;
      lastSubmittedAt: Date | null;
    }>;
  }>;
}

export function scoreSelfEvaluationQuestions(questions: QuizQuestion[], answers: Array<number | null>) {
  let correctCount = 0;
  let totalCount = 0;

  questions.forEach((question, index) => {
    if (typeof question.correctOptionIndex !== "number") {
      return;
    }

    totalCount += 1;
    const answer = Number.isFinite(Number(answers[index])) ? Number(answers[index]) : null;
    if (answer !== null && answer === question.correctOptionIndex) {
      correctCount += 1;
    }
  });

  const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
  return { score, correctCount, totalCount };
}
