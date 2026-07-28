/**
 * routes/web/shared.ts
 *
 * Shared helper layer for the web route modules: filesystem/curriculum readers,
 * quiz parsing, self-evaluation scoring, recommendation-graph loading, and the
 * in-memory teacher-quiz session store. Extracted verbatim from the former
 * monolithic web.ts so the HTTP layer (routes) is separated from business logic.
 * Only `webRouter` is a public contract, so everything here is internal.
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

const publicRoot = path.join(process.cwd(), "public");
const supportRoot = path.join(process.cwd(), "content", "Support_Cours_Préparation");
const generatedQuizzesRoot = path.join(publicRoot, "generated-quizzes");
const recommendationGraphPath = path.join(process.cwd(), "data", "graph.json");
const supportPublicPrefix = "/Support_Cours_Préparation/";
const execFileAsync = promisify(execFile);
let recommendationGraphCache: SkillsJson | null = null;
const SELF_EVALUATION_PASS_SCORE = 60;

type CurriculumNamesData = {
  modulesById: Record<string, string>;
  subAcquisById: Record<string, string>;
};

type RecommendationGraphNode = {
  title?: string;
  depends_on?: string[];
  unlocks?: string[];
};

type RecommendationGraphPayload = {
  sub_skills?: Record<string, RecommendationGraphNode>;
};

type SelfEvaluationResult = {
  moduleId: string;
  acquisId: string;
  score: number;
  passed: boolean;
  submittedAt?: Date;
};

// Teacher Quiz Generation Session Storage
type TeacherQuizGenerationSession = {
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

const teacherQuizSessions = new Map<string, TeacherQuizGenerationSession>();
const SESSION_TTL = 3600000; // 1 hour in milliseconds

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of teacherQuizSessions.entries()) {
    if (now - session.createdAt.getTime() > SESSION_TTL) {
      teacherQuizSessions.delete(sessionId);
    }
  }
}

function createStableId(prefix: string, value: string): string {
  return `${prefix}-${sanitizePathSegment(value).toLowerCase()}`;
}

function normalizeRecommendationGraph(payload: unknown): SkillsJson | null {
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

async function loadRecommendationGraph(): Promise<SkillsJson | null> {
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

function pickRecommendationMode(body: any): "recommend" | "remediation" | "revisit" | "snapshot" | "report" {
  const mode = typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "";
  if (mode === "recommend" || mode === "remediation" || mode === "revisit" || mode === "snapshot" || mode === "report") {
    return mode;
  }

  return "snapshot";
}

function parseCompletedIds(body: any): string[] {
  return Array.isArray(body?.completedIds)
    ? body.completedIds
        .filter((id: unknown): id is string => typeof id === "string" && Boolean(id.trim()))
        .map((id: string) => id.trim())
    : [];
}

function parseSubSkillScores(body: any): ScoreEntry[] {
  return Array.isArray(body?.subSkillScores)
    ? body.subSkillScores
        .filter((entry: any) => typeof entry?.subSkillId === "string" && Number.isFinite(Number(entry?.score)))
        .map((entry: any) => ({
          subSkillId: String(entry.subSkillId).trim(),
          score: Number(entry.score)
        }))
    : [];
}

function parseSkillScores(body: any): ChapterScoreEntry[] {
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

function buildCourseFileEntries(fileUrls: string[]): CurriculumCourseFile[] {
  return fileUrls.map((url, index) => ({
    id: createStableId(`course-${index + 1}`, url),
    title: path.basename(new URL(url, "http://localhost").pathname) || `Document ${index + 1}`,
    url,
    fileType: "pdf"
  }));
}

function buildVideoEntries(videoUrls: string[]): CurriculumVideo[] {
  return videoUrls.map((url, index) => ({
    id: createStableId(`video-${index + 1}`, url),
    title: `Video ${index + 1}`,
    url,
    source: /^https?:\/\//i.test(url) ? "external" : "filesystem"
  }));
}

function toCurriculumQuestion(question: QuizQuestion): CurriculumQuizQuestion {
  return {
    prompt: question.prompt,
    options: [...question.options],
    correctAnswerIndex: question.correctOptionIndex
  };
}

function moduleDocToPublic(moduleDoc: CurriculumModuleDoc): CurriculumModuleDoc {
  return {
    id: moduleDoc.id,
    name: moduleDoc.name,
    acquis: Array.isArray(moduleDoc.acquis)
      ? moduleDoc.acquis.map((acquis) => ({
          id: acquis.id,
          name: acquis.name,
          isDefaultBucket: Boolean(acquis.isDefaultBucket),
          sousAcquis: Array.isArray(acquis.sousAcquis)
            ? acquis.sousAcquis.map((entry) => ({
                id: entry.id,
                name: entry.name,
                bloomLevel: entry.bloomLevel || "",
                resource: entry.resource ? { ...entry.resource } : { type: "", ref: "" },
                lessonsCount: Number(entry.lessonsCount || 0),
                courseFiles: Array.isArray(entry.courseFiles) ? entry.courseFiles : [],
                videos: Array.isArray(entry.videos) ? entry.videos : [],
                quizzes: Array.isArray(entry.quizzes)
                  ? entry.quizzes.map((quiz) => ({
                      id: quiz.id,
                      type: quiz.type,
                      title: quiz.title,
                      questions: Array.isArray(quiz.questions)
                        ? quiz.questions.map((question) => ({
                            prompt: question.prompt,
                            options: Array.isArray(question.options) ? [...question.options] : [],
                            correctAnswerIndex:
                              typeof question.correctAnswerIndex === "number"
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
  };
}

function hasRenderableCurriculum(modules: CurriculumModuleDoc[]): boolean {
  return modules.some((moduleDoc) =>
    Array.isArray(moduleDoc.acquis) &&
    moduleDoc.acquis.some((acquis) =>
      Array.isArray(acquis.sousAcquis) &&
      acquis.sousAcquis.some((subAcquis) => {
        const hasCourseFiles = Array.isArray(subAcquis.courseFiles) && subAcquis.courseFiles.length > 0;
        const hasLegacyResource = Boolean(subAcquis.resource?.ref);
        const hasVideos = Array.isArray(subAcquis.videos) && subAcquis.videos.length > 0;
        const hasQuizzes = Array.isArray(subAcquis.quizzes) && subAcquis.quizzes.length > 0;
        return hasCourseFiles || hasLegacyResource || hasVideos || hasQuizzes;
      })
    )
  );
}

function listSubAcquisIds(moduleDoc: CurriculumModuleDoc): string[] {
  return (Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : []).flatMap((acquis) =>
    Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis.map((entry) => String(entry.id || "").trim()).filter(Boolean) : []
  );
}

function hasMissingFilesystemCurriculumEntries(
  persistedModules: CurriculumModuleDoc[],
  filesystemOverview: ModuleOverview[]
): boolean {
  // Collect all sous-acquis IDs across ALL persisted modules so that sous-acquis
  // housed under a subject-level module (e.g. "programmation-c") are still
  // recognised even though their filesystem parent dir ID ("1", "2", …) no
  // longer matches any top-level module id.
  const allPersistedSubIds = new Set<string>();
  for (const moduleDoc of persistedModules) {
    for (const id of listSubAcquisIds(moduleDoc)) {
      allPersistedSubIds.add(id);
    }
  }

  for (const moduleEntry of filesystemOverview) {
    for (const subAcquis of moduleEntry.subAcquis) {
      if (!allPersistedSubIds.has(subAcquis.id)) {
        return true;
      }
    }
  }

  return false;
}

function mergeMissingCurriculumEntries(
  persistedModules: CurriculumModuleDoc[],
  seedModules: CurriculumModuleDoc[]
): { modules: CurriculumModuleDoc[]; changed: boolean } {
  const modulesById = new Map<string, CurriculumModuleDoc>();
  let changed = false;

  for (const moduleDoc of persistedModules) {
    modulesById.set(moduleDoc.id, moduleDoc);
  }

  for (const seedModule of seedModules) {
    const current = modulesById.get(seedModule.id);
    if (!current) {
      modulesById.set(seedModule.id, seedModule);
      changed = true;
      continue;
    }

    const existingIds = new Set(listSubAcquisIds(current));
    const seedSubAcquis = listSubAcquisIds(seedModule);
    const missingIds = seedSubAcquis.filter((subId) => !existingIds.has(subId));
    if (!missingIds.length) {
      continue;
    }

    const missingEntries = (Array.isArray(seedModule.acquis) ? seedModule.acquis : [])
      .flatMap((acquis) => (Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : []))
      .filter((entry) => missingIds.includes(entry.id));

    if (!missingEntries.length) {
      continue;
    }

    const acquisList = Array.isArray(current.acquis) ? [...current.acquis] : [];
    const defaultBucketIndex = acquisList.findIndex((acquis) => Boolean(acquis.isDefaultBucket));
    if (defaultBucketIndex >= 0) {
      const bucket = acquisList[defaultBucketIndex];
      acquisList[defaultBucketIndex] = {
        ...bucket,
        sousAcquis: [...(Array.isArray(bucket.sousAcquis) ? bucket.sousAcquis : []), ...missingEntries]
      };
    } else if (acquisList.length) {
      const firstBucket = acquisList[0];
      acquisList[0] = {
        ...firstBucket,
        sousAcquis: [...(Array.isArray(firstBucket.sousAcquis) ? firstBucket.sousAcquis : []), ...missingEntries]
      };
    } else {
      acquisList.push({
        id: createStableId("acq", current.id),
        name: "Sous-acquis du module",
        isDefaultBucket: true,
        sousAcquis: missingEntries
      });
    }

    modulesById.set(seedModule.id, {
      ...current,
      acquis: acquisList
    });
    changed = true;
  }

  const mergedModules = Array.from(modulesById.values()).sort((a, b) => {
    return a.id.localeCompare(b.id, "fr", { numeric: true });
  });

  return {
    modules: mergedModules,
    changed
  };
}

function parseCurriculumNamesText(text: string): CurriculumNamesData {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const modulesById: Record<string, string> = {};
  const subAcquisById: Record<string, string> = {};

  lines.forEach((line) => {
    const moduleMatch = line.match(/^(\d+)\.\s*(.+)$/);
    if (moduleMatch && !line.startsWith("-")) {
      const moduleId = moduleMatch[1];
      const label = stripTrailingLevelNumber(moduleMatch[2]);
      if (moduleId && label) {
        modulesById[moduleId] = label;
      }
      return;
    }

    const subMatch = line.match(/^-\s*(\d+)\s*\.\s*(\d+)\s*\.?\s*(.+)$/);
    if (!subMatch) {
      return;
    }

    const moduleId = subMatch[1];
    const subId = subMatch[2];
    const label = stripTrailingLevelNumber(subMatch[3]);
    if (moduleId && subId && label) {
      subAcquisById[`${moduleId}.${subId}`] = label;
    }
  });

  return { modulesById, subAcquisById };
}

async function readCurriculumNamesFromFile(): Promise<CurriculumNamesData> {
  try {
    const namesFilePath = path.join(supportRoot, "modules+noms.txt");
    const raw = await fs.readFile(namesFilePath, "utf8");
    return parseCurriculumNamesText(raw);
  } catch (_error) {
    return { modulesById: {}, subAcquisById: {} };
  }
}

function applyCurriculumNames(modules: CurriculumModuleDoc[], names: CurriculumNamesData): {
  modules: CurriculumModuleDoc[];
  changed: boolean;
} {
  let changed = false;

  const namedModules = modules.map((moduleDoc) => {
    const expectedModuleName = names.modulesById[moduleDoc.id] || moduleDoc.name;
    if (expectedModuleName !== moduleDoc.name) {
      changed = true;
    }

    const acquis = Array.isArray(moduleDoc.acquis)
      ? moduleDoc.acquis.map((acquisEntry) => ({
          ...acquisEntry,
          sousAcquis: Array.isArray(acquisEntry.sousAcquis)
            ? acquisEntry.sousAcquis.map((subAcquis) => {
                const expectedSubName = names.subAcquisById[subAcquis.id] || subAcquis.name;
                if (expectedSubName !== subAcquis.name) {
                  changed = true;
                }

                return {
                  ...subAcquis,
                  name: expectedSubName
                };
              })
            : []
        }))
      : [];

    return {
      ...moduleDoc,
      name: expectedModuleName,
      acquis
    };
  });

  return { modules: namedModules, changed };
}

function toPublicPath(absolutePath: string): string {
  const normalized = path.normalize(absolutePath);
  if (normalized.startsWith(`${supportRoot}${path.sep}`)) {
    const relative = path.relative(supportRoot, normalized);
    return `${supportPublicPrefix}${relative.split(path.sep).join("/")}`;
  }

  const relative = path.relative(publicRoot, normalized);
  return `/${relative.split(path.sep).join("/")}`;
}

function sanitizePathSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "item";
}

function buildSourceUploadPath(
  moduleId: string,
  subAcquisId: string,
  fileName: string,
  forcedExt: ".pdf" | ".ppt" | ".pptx"
): string {
  const safeModuleId = sanitizePathSegment(moduleId);
  const safeSubAcquisId = sanitizePathSegment(subAcquisId);
  const parsed = path.parse(fileName);
  const safeBaseName = sanitizePathSegment(parsed.name || "support");

  return path.join(
    supportRoot,
    safeModuleId,
    safeSubAcquisId,
    "Cours",
    `${safeBaseName}${forcedExt}`
  );
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

async function convertPowerPointToPdf(inputPath: string, outputPath: string): Promise<void> {
  const escapedInput = escapePowerShellSingleQuoted(inputPath);
  const escapedOutput = escapePowerShellSingleQuoted(outputPath);

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$powerpoint = New-Object -ComObject PowerPoint.Application",
    "$powerpoint.Visible = 0",
    `$presentation = $powerpoint.Presentations.Open('${escapedInput}', $true, $true, $false)`,
    `$presentation.SaveAs('${escapedOutput}', 32)`,
    "$presentation.Close()",
    "$powerpoint.Quit()",
    "[System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) | Out-Null",
    "[System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerpoint) | Out-Null"
  ].join("; ");

  await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true }
  );
}

async function findFirstDirectoryByName(baseDir: string, acceptedNames: string[]): Promise<string | null> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const match = entries.find(
    (entry) => entry.isDirectory() && acceptedNames.includes(entry.name.toLowerCase())
  );

  return match ? path.join(baseDir, match.name) : null;
}

function parseQuizDocxRawText(rawText: string): QuizQuestion[] {
  const normalized = rawText
    .replace(/\r/g, "\n")
    // Some DOCX exports collapse multiple questions on one line; force a split before question starters.
    .replace(
      /([;.!?])\s+(?=(?:Quelle|Quel|Que\s+se|Qu[’']est|Comment|Pourquoi|Combien|Lequel|Laquelle|Which|What|When|Where|Why|How)\b)/gi,
      "$1\n"
    );
  const lines = normalized
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  const questions: QuizQuestion[] = [];

  let currentPrompt = "";
  let currentOptions: string[] = [];
  let currentAnswerRaw = "";

  const isAnswerLine = (line: string): boolean =>
    /^(?:Bonne\s*r[ée]ponse|R[ée]ponse(?:\s*correcte)?|Correct(?:e)?|Answer)\s*[:\-]?/i.test(line);

  const parseAnswerValue = (line: string): string =>
    normalizeWhitespace(
      line.replace(
        /^(?:Bonne\s*r[ée]ponse|R[ée]ponse(?:\s*correcte)?|Correct(?:e)?|Answer)\s*[:\-]?/i,
        ""
      )
    );

  const parseOptionLine = (line: string): string | null => {
    const markerMatch = line.match(/^([A-D]|\d+)[\).:\-]\s*(.+)$/i);
    if (markerMatch) {
      return normalizeWhitespace(markerMatch[2]);
    }

    const bulletMatch = line.match(/^(?:[-*•])\s+(.+)$/);
    if (bulletMatch) {
      return normalizeWhitespace(bulletMatch[1]);
    }

    return null;
  };

  const isQuestionStart = (line: string): boolean =>
    /^(?:Question\s*\d+|Quiz\s*\d+|Q\d+|\d+[\).])\s*/i.test(line);

  const cleanPrompt = (line: string): string =>
    normalizeWhitespace(line.replace(/^(?:Question\s*\d+|Quiz\s*\d+|Q\d+|\d+[\).])\s*[:\-]?/i, ""));

  const isLikelyQuestionSentence = (line: string): boolean =>
    /\?$/.test(line) ||
    /^(?:Quelle|Quel|Que\s+se|Qu[’']est|Comment|Pourquoi|Combien|Lequel|Laquelle|Which|What|When|Where|Why|How)\b/i.test(
      line
    );

  const hasInlineOptions = (line: string): boolean =>
    /(?:^|\s)A[\).]\s*.+(?:\s+B[\).]\s*.+\s+C[\).]\s*.+\s+D[\).]\s*)/i.test(line);

  const finalizeQuestion = () => {
    if (!currentPrompt) {
      currentPrompt = "";
      currentOptions = [];
      currentAnswerRaw = "";
      return;
    }

    if (currentOptions.length < 2) {
      const inlineReadyPrompt = currentPrompt
        .replace(/([?!:;,.])([A-Da-d][\).])/g, "$1 $2")
        .replace(/([A-Za-zÀ-ÿ0-9])([A-Da-d][\).])/g, "$1 $2");

      const inlineOptionRegex = /(?:^|\s)([A-Da-d])[\).]\s*(.+?)(?=(?:\s+[A-Da-d][\).]\s)|$)/gms;
      const inlineOptions: Array<{ letter: string; text: string }> = [];
      let inlineMatch: RegExpExecArray | null = inlineOptionRegex.exec(inlineReadyPrompt);

      while (inlineMatch) {
        inlineOptions.push({
          letter: inlineMatch[1].toUpperCase(),
          text: normalizeWhitespace(inlineMatch[2])
        });
        inlineMatch = inlineOptionRegex.exec(inlineReadyPrompt);
      }

      if (inlineOptions.length >= 2) {
        const firstMarker = inlineReadyPrompt.search(/(?:^|\s)[A-Da-d][\).]\s*/);
        if (firstMarker >= 0) {
          currentPrompt = normalizeWhitespace(inlineReadyPrompt.slice(0, firstMarker));
          currentOptions = inlineOptions.map((entry) => entry.text);
        }
      }
    }

    if (currentOptions.length < 2) {
      currentPrompt = "";
      currentOptions = [];
      currentAnswerRaw = "";
      return;
    }

    let correctOptionIndex: number | null = null;
    if (currentAnswerRaw) {
      const letterMatch = currentAnswerRaw.match(/^([A-D])(?:[\).\-:\s]|$)/i);
      if (letterMatch) {
        const letterIndex = ["A", "B", "C", "D"].indexOf(letterMatch[1].toUpperCase());
        if (letterIndex >= 0 && letterIndex < currentOptions.length) {
          correctOptionIndex = letterIndex;
        }
      }

      if (correctOptionIndex === null) {
        const numberMatch = currentAnswerRaw.match(/^(\d+)(?:[\).\-:\s]|$)/);
        if (numberMatch) {
          const index = Number(numberMatch[1]) - 1;
          if (index >= 0 && index < currentOptions.length) {
            correctOptionIndex = index;
          }
        }
      }

      if (correctOptionIndex === null) {
        const normalizedAnswer = normalizeForComparison(currentAnswerRaw);
        const optionIndexByText = currentOptions.findIndex((option) => {
          const normalizedOption = normalizeForComparison(option);
          return (
            normalizedOption === normalizedAnswer ||
            normalizedOption.includes(normalizedAnswer) ||
            normalizedAnswer.includes(normalizedOption)
          );
        });

        if (optionIndexByText >= 0) {
          correctOptionIndex = optionIndexByText;
        }
      }
    }

    questions.push({
      prompt: currentPrompt,
      options: [...currentOptions],
      correctOptionIndex
    });

    currentPrompt = "";
    currentOptions = [];
    currentAnswerRaw = "";
  };

  for (const line of lines) {
    if (isAnswerLine(line)) {
      currentAnswerRaw = parseAnswerValue(line);
      continue;
    }

    if (currentAnswerRaw && isLikelyQuestionSentence(line)) {
      finalizeQuestion();
      currentPrompt = line;
      continue;
    }

    if (isQuestionStart(line)) {
      finalizeQuestion();
      currentPrompt = cleanPrompt(line);
      continue;
    }

    if (currentPrompt && currentOptions.length === 0 && isLikelyQuestionSentence(line) && hasInlineOptions(line)) {
      finalizeQuestion();
      currentPrompt = line;
      continue;
    }

    const optionText = parseOptionLine(line);
    if (optionText) {
      if (!currentPrompt) {
        currentPrompt = "Question";
      }
      currentOptions.push(optionText);
      continue;
    }

    const canBeBareOption =
      Boolean(currentPrompt) &&
      !isLikelyQuestionSentence(line) &&
      (isLikelyQuestionSentence(currentPrompt) || currentOptions.length > 0);

    if (canBeBareOption) {
      currentOptions.push(line);
      continue;
    }

    if (isLikelyQuestionSentence(line) && currentOptions.length >= 2) {
      finalizeQuestion();
      currentPrompt = line;
      continue;
    }

    if (!currentPrompt) {
      currentPrompt = line;
      continue;
    }

    if (currentOptions.length === 0) {
      currentPrompt = normalizeWhitespace(`${currentPrompt} ${line}`);
    }
  }

  finalizeQuestion();
  return questions;
}

function parseNormalizedQuizJson(rawJson: string): QuizQuestion[] {
  const parsed = JSON.parse(rawJson) as QuizJsonPayload;
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];

  return questions
    .map((question) => {
      const prompt = normalizeWhitespace(String(question?.prompt ?? ""));
      const options = Array.isArray(question?.options)
        ? question.options.map((entry) => normalizeWhitespace(String(entry))).filter(Boolean)
        : [];
      const correctRaw = question?.correctOptionIndex;
      const correctOptionIndex =
        typeof correctRaw === "number" && Number.isFinite(correctRaw) ? Number(correctRaw) : null;

      return { prompt, options, correctOptionIndex };
    })
    .filter((question) => question.prompt.length > 0 && question.options.length >= 2)
    .map((question) => {
      const boundedCorrectIndex =
        question.correctOptionIndex !== null &&
        question.correctOptionIndex >= 0 &&
        question.correctOptionIndex < question.options.length
          ? question.correctOptionIndex
          : null;

      return {
        prompt: question.prompt,
        options: question.options,
        correctOptionIndex: boundedCorrectIndex
      };
    });
}

// Quiz attempt policy (kept in sync with the client in questionnaire.html):
// a student gets at most QUIZ_MAX_ATTEMPTS tries, and a score >= QUIZ_PASS_SCORE
// counts as validated. Once validated or out of attempts, the quiz is locked.
const QUIZ_PASS_SCORE = 60;
const QUIZ_MAX_ATTEMPTS = 2;

type QuizAttemptState = {
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
async function readQuizAttemptState(
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
async function hasActiveRemediationQuiz(
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

function buildRemediationQuizJsonFilePath(params: {
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

async function saveRemediationQuizJsonFile(params: {
  filePath: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.filePath), { recursive: true });
  await fs.writeFile(params.filePath, `${JSON.stringify(params.payload, null, 2)}\n`, "utf8");
}

async function subAcquisHasQuiz(subRoot: string): Promise<boolean> {
  const quizDirectory = await findFirstDirectoryByName(subRoot, ["quiz", "quizz"]);
  if (!quizDirectory) return false;

  const quizEntries = await fs.readdir(quizDirectory, { withFileTypes: true });
  return quizEntries.some((entry) => {
    if (!entry.isFile()) return false;
    const extension = path.extname(entry.name).toLowerCase();
    return extension === ".docx" || extension === ".json";
  });
}

async function subAcquisHasVideo(subRoot: string): Promise<boolean> {
  const externalVideoLinks = await readExternalVideoLinks(subRoot);
  if (externalVideoLinks.length > 0) {
    return true;
  }

  const videoExtensions = new Set([".mp4", ".webm", ".ogg", ".mov", ".m4v"]);

  const scan = async (currentDir: string, inVideoScope: boolean): Promise<boolean> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isFile()) {
        if (inVideoScope && videoExtensions.has(path.extname(entry.name).toLowerCase())) {
          return true;
        }
        continue;
      }

      if (!entry.isDirectory()) continue;

      const nextScope = inVideoScope || normalizeForLookup(entry.name).includes("video");
      const found = await scan(fullPath, nextScope);
      if (found) {
        return true;
      }
    }

    return false;
  };

  return scan(subRoot, false);
}

function extractHttpLinksFromUnknownPayload(payload: unknown): string[] {
  const links = new Set<string>();

  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        links.add(trimmed);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => collect(entry));
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    const record = value as Record<string, unknown>;
    ["videoLinks", "videos", "links"].forEach((key) => {
      if (key in record) {
        collect(record[key]);
      }
    });

    ["url", "link", "href"].forEach((key) => {
      if (key in record) {
        collect(record[key]);
      }
    });
  };

  collect(payload);
  return Array.from(links);
}

async function readExternalVideoLinks(subRoot: string): Promise<string[]> {
  const candidateJsonFiles = new Set(["video-links.json", "videos.links.json", "videos.json"]);
  const candidateTextFiles = new Set(["video-links.txt", "videos.links.txt"]);
  const links = new Set<string>();

  const scan = async (currentDir: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const lowerName = entry.name.toLowerCase();

      if (candidateJsonFiles.has(lowerName)) {
        try {
          const rawJson = await fs.readFile(fullPath, "utf8");
          const parsed = JSON.parse(rawJson) as unknown;
          extractHttpLinksFromUnknownPayload(parsed).forEach((link) => links.add(link));
        } catch (error) {
          console.warn("Failed to parse external video links JSON:", fullPath, error);
        }
        continue;
      }

      if (candidateTextFiles.has(lowerName)) {
        try {
          const rawText = await fs.readFile(fullPath, "utf8");
          rawText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^https?:\/\//i.test(line))
            .forEach((link) => links.add(link));
        } catch (error) {
          console.warn("Failed to parse external video links text file:", fullPath, error);
        }
      }
    }
  };

  await scan(subRoot);

  if (links.size === 0) {
    const globalCandidates = [
      path.join(supportRoot, "video-links.json"),
      path.join(supportRoot, "video-links.template.json")
    ];

    for (const candidatePath of globalCandidates) {
      try {
        const rawJson = await fs.readFile(candidatePath, "utf8");
        const parsed = JSON.parse(rawJson) as {
          applyToAllSubAcquis?: boolean;
          videoLinks?: unknown;
        };

        // Global links are opt-in to avoid leaking the same videos to every sous-acquis.
        if (parsed?.applyToAllSubAcquis === true) {
          extractHttpLinksFromUnknownPayload(parsed.videoLinks || []).forEach((link) => links.add(link));
        }
      } catch (_error) {
        // Ignore missing or invalid global files and continue fallback attempts.
      }

      if (links.size > 0) {
        break;
      }
    }
  }

  return Array.from(links);
}

async function readProgramCOverview(): Promise<ModuleOverview[]> {
  const moduleEntries = await fs.readdir(supportRoot, { withFileTypes: true });
  const modules = await Promise.all(
    moduleEntries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .sort((a, b) => Number(a.name) - Number(b.name))
      .map(async (moduleEntry) => {
        const modulePath = path.join(supportRoot, moduleEntry.name);
        const moduleChildren = await fs.readdir(modulePath, { withFileTypes: true });

        const subAcquis = await Promise.all(
          moduleChildren
            .filter((child) => child.isDirectory() && /^\d+\.\d+$/.test(child.name))
            .sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }))
            .map(async (child) => {
              const subRoot = path.join(modulePath, child.name);
              const [hasQuiz, hasVideo] = await Promise.all([
                subAcquisHasQuiz(subRoot),
                subAcquisHasVideo(subRoot)
              ]);

              return {
                id: child.name,
                name: child.name,
                hasQuiz,
                hasVideo
              };
            })
        );

        return {
          id: moduleEntry.name,
          name: moduleEntry.name,
          sortOrder: Math.max(0, Number(moduleEntry.name) - 1),
          subAcquisCount: subAcquis.length,
          subAcquis
        };
      })
  );

  return modules;
}

async function readSubAcquisResources(moduleId: string, subAcquisId: string): Promise<{
  pptFiles: string[];
  videoFiles: string[];
  quizQuestionCount: number;
  quizQuestions: QuizQuestion[];
}> {
  const subRoot = path.join(supportRoot, moduleId, subAcquisId);
  const entries = await fs.readdir(subRoot, { withFileTypes: true });

  const coursDirectory = entries.find(
    (entry) => entry.isDirectory() && entry.name.toLowerCase() === "cours"
  );
  const quizDirectory = entries.find(
    (entry) => entry.isDirectory() && ["quiz", "quizz"].includes(entry.name.toLowerCase())
  );

  let pptFiles: string[] = [];
  if (coursDirectory) {
    const coursPath = path.join(subRoot, coursDirectory.name);
    const coursFiles = await fs.readdir(coursPath, { withFileTypes: true });

    pptFiles = coursFiles
      .filter(
        (file) =>
          file.isFile() && [".ppt", ".pptx", ".pdf"].includes(path.extname(file.name).toLowerCase())
      )
      .sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }))
      .map((file) => toPublicPath(path.join(coursPath, file.name)));
  }

  // Some legacy sous-acquis store course files directly in the sub-acquis root
  // instead of a dedicated "Cours" directory. Keep them discoverable.
  if (!pptFiles.length) {
    pptFiles = entries
      .filter(
        (file) =>
          file.isFile() && [".ppt", ".pptx", ".pdf"].includes(path.extname(file.name).toLowerCase())
      )
      .sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }))
      .map((file) => toPublicPath(path.join(subRoot, file.name)));
  }

  const videoExtensions = new Set([".mp4", ".webm", ".ogg", ".mov", ".m4v"]);
  const videoFiles = new Set<string>();

  const scanForVideoFiles = async (currentDir: string): Promise<void> => {
    const dirEntries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of dirEntries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (normalizeForLookup(entry.name).includes("video")) {
          await collectVideoFiles(fullPath);
        }

        await scanForVideoFiles(fullPath);
      }
    }
  };

  const collectVideoFiles = async (videoDir: string): Promise<void> => {
    const videoEntries = await fs.readdir(videoDir, { withFileTypes: true });

    videoEntries
      .filter((file) => file.isFile() && videoExtensions.has(path.extname(file.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }))
      .forEach((file) => {
        videoFiles.add(toPublicPath(path.join(videoDir, file.name)));
      });
  };

  await scanForVideoFiles(subRoot);
  const externalVideoLinks = await readExternalVideoLinks(subRoot);
  externalVideoLinks.forEach((link) => videoFiles.add(link));

  let quizQuestions: QuizQuestion[] = [];
  if (quizDirectory) {
    const quizPath = path.join(subRoot, quizDirectory.name);
    const quizFiles = await fs.readdir(quizPath, { withFileTypes: true });
    const normalizedJson = quizFiles.find(
      (file) => file.isFile() && file.name.toLowerCase().endsWith(".normalized.json")
    );
    const quizDocx = quizFiles.find(
      (file) => file.isFile() && path.extname(file.name).toLowerCase() === ".docx"
    );

    let normalizedQuestions: QuizQuestion[] = [];
    if (normalizedJson) {
      try {
        const normalizedJsonPath = path.join(quizPath, normalizedJson.name);
        const rawJson = await fs.readFile(normalizedJsonPath, "utf8");
        normalizedQuestions = parseNormalizedQuizJson(rawJson);
      } catch (error) {
        console.warn("Failed to read normalized quiz JSON, falling back to DOCX:", error);
      }
    }

    let docxQuestions: QuizQuestion[] = [];
    if (quizDocx) {
      try {
        const quizDocxPath = path.join(quizPath, quizDocx.name);
        const rawResult = await mammoth.extractRawText({ path: quizDocxPath });
        docxQuestions = parseQuizDocxRawText(rawResult.value);
      } catch (error) {
        console.warn("Failed to parse quiz DOCX:", error);
      }
    }

    // Keep the richest source automatically; this protects against stale normalized files.
    quizQuestions = docxQuestions.length > normalizedQuestions.length ? docxQuestions : normalizedQuestions;
  }

  return {
    pptFiles,
    videoFiles: Array.from(videoFiles),
    quizQuestionCount: quizQuestions.length,
    quizQuestions
  };
}

async function buildCurriculumSeedFromFilesystem(): Promise<CurriculumModuleDoc[]> {
  const overview = await readProgramCOverview();
  const modules: CurriculumModuleDoc[] = [];

  for (const moduleEntry of overview) {
    const modulePath = path.join(supportRoot, moduleEntry.id);
    const moduleChildren = await fs.readdir(modulePath, { withFileTypes: true });
    const subAcquisEntries = moduleChildren
      .filter((child) => child.isDirectory() && /^\d+\.\d+$/.test(child.name))
      .sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }));

    const subAcquis: CurriculumSubAcquis[] = [];

    for (const child of subAcquisEntries) {
      const resources = await readSubAcquisResources(moduleEntry.id, child.name);
      const courseFiles = [] as CurriculumCourseFile[];
      for (const fileUrl of resources.pptFiles) {
        const mirrored = await mirrorPublicFileToGridFs(fileUrl, {
          moduleId: moduleEntry.id,
          subAcquisId: child.name,
          kind: "course-file"
        });
        courseFiles.push({
          id: createStableId("course", mirrored.url),
          title: mirrored.title,
          url: mirrored.url,
          fileType: mirrored.fileType
        });
      }

      const videos = [] as CurriculumVideo[];
      for (const videoUrl of resources.videoFiles) {
        const mirrored = await mirrorPublicFileToGridFs(videoUrl, {
          moduleId: moduleEntry.id,
          subAcquisId: child.name,
          kind: "video-file"
        });
        videos.push({
          id: createStableId("video", mirrored.url),
          title: mirrored.title,
          url: mirrored.url,
          source: /^https?:\/\//i.test(videoUrl) ? "external" : "filesystem"
        });
      }

      const quizzes = resources.quizQuestions.length
        ? [
            {
              id: createStableId("quiz", child.name),
              type: "qcm",
              title: `Quiz ${child.name}`,
              questions: resources.quizQuestions.map(toCurriculumQuestion)
            }
          ]
        : [];

      subAcquis.push({
        id: child.name,
        name: child.name,
        bloomLevel: "",
        resource: courseFiles[0]
          ? {
              type: courseFiles[0].fileType,
              ref: courseFiles[0].url
            }
          : { type: "", ref: "" },
        lessonsCount: Math.max(0, courseFiles.length),
        courseFiles,
        videos,
        quizzes
      });
    }

    modules.push({
      id: moduleEntry.id,
      name: moduleEntry.id,
      acquis: [
        {
          id: createStableId("acq", moduleEntry.id),
          name: "Sous-acquis du module",
          isDefaultBucket: true,
          sousAcquis: subAcquis
        }
      ]
    });
  }

  return modules;
}

async function ensureCurriculumSeeded(): Promise<void> {
  const count = await CurriculumModule.countDocuments();
  if (count > 0) {
    return;
  }

  const seedModules = await buildCurriculumSeedFromFilesystem();
  if (!seedModules.length) {
    return;
  }

  await CurriculumModule.insertMany(
    seedModules.map((moduleDoc, index) => ({
      ...moduleDoc,
      sortOrder: index
    }))
  );
}

export async function readPersistedCurriculumModules(): Promise<CurriculumModuleDoc[]> {
  await ensureCurriculumSeeded();

  const modules = await CurriculumModule.find()
    .sort({ sortOrder: 1, createdAt: 1, id: 1 })
    .lean();
  const publicModules = modules.map((moduleDoc) => moduleDocToPublic(moduleDoc as CurriculumModuleDoc));
  const names = await readCurriculumNamesFromFile();
  const named = applyCurriculumNames(publicModules, names);
  const namedModules = named.modules;

  if (!namedModules.length || !hasRenderableCurriculum(namedModules)) {
    const seedModules = await buildCurriculumSeedFromFilesystem();
    if (seedModules.length) {
      await savePersistedCurriculumModules(seedModules);
      return seedModules;
    }
  }

  const filesystemOverview = await readProgramCOverview();
  if (hasMissingFilesystemCurriculumEntries(namedModules, filesystemOverview)) {
    const seedModules = await buildCurriculumSeedFromFilesystem();
    if (seedModules.length) {
      const merged = mergeMissingCurriculumEntries(namedModules, seedModules);
      if (merged.changed) {
        await savePersistedCurriculumModules(merged.modules);
        return merged.modules;
      }
    }
  }

  let changed = named.changed;

  const migratedModules = await Promise.all(
    namedModules.map(async (moduleDoc) => {
      const acquisList = Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : [];

      const migratedAcquis = await Promise.all(
        acquisList.map(async (acquis) => {
          const subAcquisList = Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : [];

          const migratedSubAcquis = await Promise.all(
            subAcquisList.map(async (subAcquis) => {
              const migratedCourseFiles = [] as CurriculumCourseFile[];
              for (const fileEntry of Array.isArray(subAcquis.courseFiles) ? subAcquis.courseFiles : []) {
                if (isLocalMediaUrl(fileEntry.url)) {
                  const mirrored = await mirrorPublicFileToGridFs(fileEntry.url, {
                    moduleId: moduleDoc.id,
                    subAcquisId: subAcquis.id,
                    kind: "course-file"
                  });
                  migratedCourseFiles.push({
                    id: fileEntry.id || createStableId("course", mirrored.url),
                    title: fileEntry.title || mirrored.title,
                    url: mirrored.url,
                    fileType: fileEntry.fileType || mirrored.fileType
                  });
                  changed = true;
                } else {
                  migratedCourseFiles.push(fileEntry);
                }
              }

              const migratedVideos = [] as CurriculumVideo[];
              for (const videoEntry of Array.isArray(subAcquis.videos) ? subAcquis.videos : []) {
                if (isLocalMediaUrl(videoEntry.url)) {
                  const mirrored = await mirrorPublicFileToGridFs(videoEntry.url, {
                    moduleId: moduleDoc.id,
                    subAcquisId: subAcquis.id,
                    kind: "video-file"
                  });
                  migratedVideos.push({
                    id: videoEntry.id || createStableId("video", mirrored.url),
                    title: videoEntry.title || mirrored.title,
                    url: mirrored.url,
                    source: videoEntry.source || "filesystem"
                  });
                  changed = true;
                } else {
                  migratedVideos.push(videoEntry);
                }
              }

              return {
                ...subAcquis,
                courseFiles: migratedCourseFiles,
                videos: migratedVideos
              };
            })
          );

          return {
            ...acquis,
            sousAcquis: migratedSubAcquis
          };
        })
      );

      return {
        ...moduleDoc,
        acquis: migratedAcquis
      };
    })
  );

  if (changed) {
    await savePersistedCurriculumModules(migratedModules as CurriculumModuleDoc[]);
  }

  return migratedModules as CurriculumModuleDoc[];
}

async function savePersistedCurriculumModules(modules: CurriculumModuleDoc[]): Promise<void> {
  const normalizedModules = modules.map((moduleDoc, index) => ({
    ...moduleDocToPublic(moduleDoc),
    sortOrder: index
  }));
  const moduleIds = normalizedModules.map((moduleDoc) => moduleDoc.id);

  await CurriculumModule.bulkWrite(
    normalizedModules.map((moduleDoc) => ({
      updateOne: {
        filter: { id: moduleDoc.id },
        update: moduleDoc,
        upsert: true
      }
    }))
  );

  await CurriculumModule.deleteMany(moduleIds.length ? { id: { $nin: moduleIds } } : {});

  // Curriculum content changed — trigger a background reindex of the Python
  // chatbot vector store (ChromaDB). Fire-and-forget; dedups on chunk id.
  requestPythonReindex(normalizedModules);
}

export async function readPersistedProgramCOverview(): Promise<ModuleOverview[]> {
  const modules = await readPersistedCurriculumModules();
  return modules.map(moduleDocToOverview);
}

export async function readClassAccessByStudentIdentifier(identifier: string): Promise<ClassAccessContext | null> {
  const normalizedIdentifier = String(identifier || "").trim();
  if (!normalizedIdentifier) {
    return null;
  }

  const student = await StudentProfile.findOne({ identifier: normalizedIdentifier })
    .select({ classId: 1 })
    .lean();

  if (!student?.classId) {
    return null;
  }

  const classRoom = await ClassRoom.findById(student.classId)
    .select({ _id: 1, accessByModule: 1, scheduleStartDate: 1, accessScheduleBySubAcquis: 1 })
    .lean();

  if (!classRoom) {
    return null;
  }

  const scheduleStartDate = toIsoDateOrNull((classRoom as any).scheduleStartDate);
  let resolvedScheduleBySubAcquis = toScheduleIsoRecord((classRoom as any).accessScheduleBySubAcquis);

  // Keep scheduling aligned with calendar.txt even if persisted schedule snapshots are outdated.
  if (scheduleStartDate) {
    const parsedStartDate = parseStartDateInput(scheduleStartDate);
    if (parsedStartDate) {
      try {
        const [overview, weekMap] = await Promise.all([
          readPersistedProgramCOverview(),
          readCalendarWeekMapFromFile()
        ]);

        resolvedScheduleBySubAcquis = buildScheduleBySubAcquis({
          overview,
          weekMap,
          startDate: parsedStartDate
        });
      } catch (_error) {
        // Fallback to persisted schedule if recomputation fails.
      }
    }
  }

  return {
    classId: String((classRoom as any)._id || ""),
    accessByModule: toAccessRecord((classRoom as any).accessByModule),
    scheduleStartDate,
    accessScheduleBySubAcquis: resolvedScheduleBySubAcquis
  };
}

async function readPersistedSubAcquisResources(moduleId: string, subAcquisId: string): Promise<{
  moduleName: string;
  acquisName: string;
  subAcquisName: string;
  pptFiles: string[];
  videoFiles: string[];
  quizQuestionCount: number;
  quizQuestions: QuizQuestion[];
}> {
  const modules = await readPersistedCurriculumModules();
  const module = modules.find((entry) => entry.id === moduleId);
  if (!module) {
    return {
      moduleName: moduleId,
      acquisName: "",
      subAcquisName: subAcquisId,
      pptFiles: [],
      videoFiles: [],
      quizQuestionCount: 0,
      quizQuestions: []
    };
  }

  // Locate the sous-acquis AND its parent acquis (the "skill" level) so the
  // lesson breadcrumb can show module -> skill -> sous-acquis.
  let subAcquis: (typeof module.acquis)[number]["sousAcquis"][number] | undefined;
  let acquisName = "";
  for (const acquis of module.acquis) {
    const found = acquis.sousAcquis.find((entry) => entry.id === subAcquisId);
    if (found) {
      subAcquis = found;
      acquisName = acquis.name || acquis.id;
      break;
    }
  }
  if (!subAcquis) {
    return {
      moduleName: module.name || module.id,
      acquisName: "",
      subAcquisName: subAcquisId,
      pptFiles: [],
      videoFiles: [],
      quizQuestionCount: 0,
      quizQuestions: []
    };
  }

  let pptFiles = Array.isArray(subAcquis.courseFiles) && subAcquis.courseFiles.length
    ? subAcquis.courseFiles.map((entry) => entry.url)
    : subAcquis.resource?.ref
      ? [subAcquis.resource.ref]
      : [];

  const filesystemResources = await readSubAcquisResources(moduleId, subAcquisId).catch(() => ({
    pptFiles: [],
    videoFiles: [],
    quizQuestionCount: 0,
    quizQuestions: [] as QuizQuestion[]
  }));

  if (!pptFiles.length && Array.isArray(filesystemResources.pptFiles) && filesystemResources.pptFiles.length) {
    pptFiles = [...filesystemResources.pptFiles];
  }

  const trustedPersistedVideoUrls = Array.isArray(subAcquis.videos)
    ? subAcquis.videos
        .filter((entry) => {
          const url = String(entry?.url || "");
          const source = String(entry?.source || "").toLowerCase();
          return url.startsWith("/api/media/") || source === "db" || source === "gridfs";
        })
        .map((entry) => String(entry.url || "").trim())
        .filter(Boolean)
    : [];

  const fsVideoFiles = Array.isArray(filesystemResources.videoFiles) ? filesystemResources.videoFiles : [];
  const fsKeys = new Set(fsVideoFiles.map((url) => canonicalMediaKey(url)).filter(Boolean));
  const dedupedTrustedUrls = trustedPersistedVideoUrls.filter((url) => {
    const key = canonicalMediaKey(url);
    return !key || !fsKeys.has(key);
  });

  // External video links should come from the sous-acquis folder data files, not stale DB snapshots.
  const videoFiles = Array.from(new Set([...fsVideoFiles, ...dedupedTrustedUrls]));

  const quizQuestions = Array.isArray(subAcquis.quizzes)
    ? subAcquis.quizzes.flatMap((quiz) =>
        Array.isArray(quiz.questions)
          ? quiz.questions.map((question) => ({
              prompt: question.prompt,
              options: Array.isArray(question.options) ? [...question.options] : [],
              correctOptionIndex: question.correctAnswerIndex
            }))
          : []
      )
    : [];

  return {
    moduleName: module.name || module.id,
    acquisName,
    subAcquisName: subAcquis.name || subAcquis.id,
    pptFiles,
    videoFiles,
    quizQuestionCount: quizQuestions.length,
    quizQuestions
  };
}

function makeSelfEvaluationKey(moduleId: string, acquisId: string): string {
  return `${moduleId}::${acquisId}`;
}

function collectAcquisQuizQuestions(acquis: CurriculumAcquis): QuizQuestion[] {
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

function extractSelfEvaluationResults(user: { progress?: { selfEvaluationResults?: SelfEvaluationResult[] } } | null) {
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

function buildSelfEvaluationOverview(
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

function scoreSelfEvaluationQuestions(questions: QuizQuestion[], answers: Array<number | null>) {
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


// Barrel export of the shared helper layer consumed by the route modules.
export {
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
  readCurriculumNamesFromFile,
  readExternalVideoLinks,
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
};

// ---------------------------------------------------------------------------
// Curriculum size (shared by prediction routes and organization.ts).
// ---------------------------------------------------------------------------
// Cached curriculum size (denominator for gapDepth). Refreshed lazily so the
// prediction endpoints don't hardcode a wrong total (the old default was 20
// while the real curriculum has ~42 sous-acquis).
let cachedTotalSubAcquis: { at: number; value: number } | null = null;
const TOTAL_SUB_ACQUIS_TTL_MS = 10 * 60 * 1000;

export async function resolveTotalSubAcquisCount(): Promise<number> {
  const now = Date.now();
  if (cachedTotalSubAcquis && now - cachedTotalSubAcquis.at < TOTAL_SUB_ACQUIS_TTL_MS) {
    return cachedTotalSubAcquis.value;
  }
  let count = 0;
  try {
    const modules = await CurriculumModule.find().select({ acquis: 1 }).lean();
    for (const moduleDoc of modules as any[]) {
      for (const acquis of Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : []) {
        count += Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis.length : 0;
      }
    }
  } catch (_error) {
    count = 0;
  }
  const value = count > 0 ? count : 42;
  cachedTotalSubAcquis = { at: now, value };
  return value;
}
