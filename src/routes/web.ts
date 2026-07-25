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
import { authRouter } from "./auth";
import { User } from "../models/User";
import { Teacher } from "../models/Teacher";
import { ClassRoom } from "../models/ClassRoom";
import { StudentProfile } from "../models/StudentProfile";
import { CurriculumModule } from "../models/CurriculumModule";
import { StudentRemediationQuiz } from "../models/StudentRemediationQuiz";
import { hashPassword } from "../utils/password";
import { Recommender, type ChapterScoreEntry, type RecommendOptions, type ScoreEntry, type SkillsJson } from "../services/recommendation/skill-recommender.js";
import { computeRemediationTargets, type RemediationTarget } from "../services/recommendation/remediationTargets.js";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env";
import { MLPredictorService } from "../services/MLPredictorService";
import { type PredictionFeatures, type PredictionModuleInfo, extractMLFeatures } from "../services/prediction/features";
import { resolveRiskExplanation } from "../services/prediction/explain";
import { buildLessonKey, computeModuleQuizScores, computeStudentProgress } from "../services/studentProgress";
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
} from "../services/classAccess";
import {
  generateTeacherQuizQuestions,
  type TeacherGeneratedQuestion
} from "../services/quiz/quizGenClient";
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
} from "../services/courseContent";
import { requestPythonReindex } from "../services/chatbot/ragClient";
import {
  normalizeForComparison,
  normalizeForLookup,
  normalizeWhitespace,
  stripTrailingLevelNumber
} from "../services/textNormalize";
import { moduleDocToOverview } from "../services/curriculum";
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
} from "../types/curriculum";

const webRouter = Router();

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
      subAcquisName: subAcquisId,
      pptFiles: [],
      videoFiles: [],
      quizQuestionCount: 0,
      quizQuestions: []
    };
  }

  const subAcquis = module.acquis.flatMap((acquis) => acquis.sousAcquis).find((entry) => entry.id === subAcquisId);
  if (!subAcquis) {
    return {
      moduleName: module.name || module.id,
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

// Include authentication routes
webRouter.use(authRouter);

// Health endpoint for quick server checks from tools or load balancers.
webRouter.get("/api/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "nextlearn-web"
  });
});

webRouter.post("/api/recommendations", async (req, res) => {
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
webRouter.get("/api/student/modules", async (req, res) => {
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
webRouter.get("/api/student/module/:moduleId", async (req, res) => {
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
webRouter.get("/api/programmation-c/modules", async (req, res) => {
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

webRouter.get("/api/programmation-c/overview", async (req, res) => {
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

webRouter.get("/api/backoffice/curriculum", async (_req, res) => {
  try {
    const modules = await readPersistedCurriculumModules();
    res.status(200).json({ modules });
  } catch (error) {
    console.error("Failed to load backoffice curriculum:", error);
    res.status(500).json({ message: "Impossible de charger le curriculum" });
  }
});

webRouter.put("/api/backoffice/curriculum", async (req, res) => {
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

webRouter.get("/api/media/:fileId/:filename", async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!mongoose.mongo.ObjectId.isValid(fileId)) {
      return res.status(400).json({ message: "Identifiant de fichier invalide" });
    }

    const bucket = getCurriculumMediaBucket();
    const objectId = new mongoose.mongo.ObjectId(fileId);
    const files = await bucket.find({ _id: objectId }).toArray();
    const file = files[0];

    if (!file) {
      return res.status(404).json({ message: "Fichier introuvable" });
    }

    const contentType =
      (file.metadata as { contentType?: string } | undefined)?.contentType ||
      inferContentType(file.filename || req.params.filename);

    const fileLength = Number(file.length) || 0;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.filename || req.params.filename)}"`);
    // Advertise range support so HTML5 <video>/<audio> can stream and seek.
    res.setHeader("Accept-Ranges", "bytes");

    const pipeStream = (streamOptions?: { start: number; end: number }) => {
      // GridFS `end` is exclusive.
      const downloadStream = streamOptions
        ? bucket.openDownloadStream(objectId, { start: streamOptions.start, end: streamOptions.end + 1 })
        : bucket.openDownloadStream(objectId);
      downloadStream.on("error", (error) => {
        console.error("Failed to stream media file:", error);
        if (!res.headersSent) {
          res.status(500).end("Failed to stream file");
        } else {
          res.end();
        }
      });
      // Stop reading from GridFS if the client aborts (e.g. seeking a video).
      res.on("close", () => downloadStream.destroy());
      downloadStream.pipe(res);
    };

    const rangeHeader = req.headers.range;
    if (rangeHeader && fileLength > 0) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
      if (!match || (!match[1] && !match[2])) {
        res.status(416).setHeader("Content-Range", `bytes */${fileLength}`).end();
        return;
      }

      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : fileLength - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= fileLength) end = fileLength - 1;

      if (start > end || start >= fileLength || start < 0) {
        res.status(416).setHeader("Content-Range", `bytes */${fileLength}`).end();
        return;
      }

      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileLength}`);
      res.setHeader("Content-Length", end - start + 1);
      pipeStream({ start, end });
      return;
    }

    if (fileLength > 0) {
      res.setHeader("Content-Length", fileLength);
    }
    pipeStream();
  } catch (error) {
    console.error("Failed to load media file:", error);
    res.status(500).json({ message: "Impossible de charger le fichier" });
  }
});

// Backoffice course file upload endpoint.
// Accepts PDF or PowerPoint files and always returns a public PDF URL.
webRouter.post("/api/backoffice/upload-course-file", async (req, res) => {
  try {
    const { moduleId, subAcquisId, fileName, fileType, fileDataUrl } = req.body ?? {};

    if (
      typeof moduleId !== "string" ||
      typeof subAcquisId !== "string" ||
      typeof fileName !== "string" ||
      typeof fileDataUrl !== "string"
    ) {
      return res.status(400).json({ message: "Payload upload invalide" });
    }

    const lowerName = fileName.toLowerCase();
    const isPdfByExt = lowerName.endsWith(".pdf");
    const isPptxByExt = lowerName.endsWith(".pptx");
    const isPptByExt = lowerName.endsWith(".ppt");
    const isPdfByMime = fileType === "application/pdf";
    const isPptxByMime =
      fileType === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    const isPptByMime = fileType === "application/vnd.ms-powerpoint";

    const isPdf = isPdfByExt || isPdfByMime;
    const isPowerPoint = isPptByExt || isPptxByExt || isPptByMime || isPptxByMime;

    if (!isPdf && !isPowerPoint) {
      return res.status(400).json({ message: "Seuls les formats PDF et PowerPoint sont acceptes" });
    }

    const match = fileDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ message: "Le fichier doit etre envoye en base64" });
    }

    const mimeType = match[1];
    const base64Payload = match[2];

    if (!isPdf && !isPowerPoint) {
      return res.status(400).json({ message: "Type de fichier non supporte" });
    }

    if (isPdf && mimeType !== "application/pdf") {
      return res.status(400).json({ message: "Le mime-type PDF est invalide" });
    }

    if (
      isPowerPoint &&
      ![
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.ms-powerpoint"
      ].includes(mimeType)
    ) {
      return res.status(400).json({ message: "Le mime-type PowerPoint est invalide" });
    }

    const safeBaseName = sanitizePathSegment(path.parse(fileName).name || "support");

    let finalBuffer = Buffer.from(base64Payload, "base64");
    let finalFilename = `${safeBaseName}.pdf`;

    if (!isPdf) {
      const sourceExt: ".ppt" | ".pptx" = isPptByExt || isPptByMime ? ".ppt" : ".pptx";
      const sourcePath = buildSourceUploadPath(moduleId, subAcquisId, fileName, sourceExt);
      const outputPdfPath = path.join(
        process.cwd(),
        "tmp",
        "curriculum-media",
        `${safeBaseName}-${Date.now()}.pdf`
      );

      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.mkdir(path.dirname(outputPdfPath), { recursive: true });
      await fs.writeFile(sourcePath, Buffer.from(base64Payload, "base64"));

      try {
        await convertPowerPointToPdf(sourcePath, outputPdfPath);
        finalBuffer = await fs.readFile(outputPdfPath);
        finalFilename = path.basename(outputPdfPath);
        await fs.unlink(outputPdfPath).catch(() => undefined);
      } catch (conversionError) {
        console.error("PowerPoint to PDF conversion failed:", conversionError);
        return res.status(500).json({
          message:
            "Conversion PPTX vers PDF impossible. Verifiez que Microsoft PowerPoint est installe sur le serveur."
        });
      } finally {
        await fs.unlink(sourcePath).catch(() => undefined);
      }
    }

    const uploadResult = await uploadBufferToGridFs({
      buffer: finalBuffer,
      filename: finalFilename,
      contentType: "application/pdf",
      metadata: { moduleId, subAcquisId, kind: "course-file" }
    });

    res.status(201).json({
      publicUrl: uploadResult.publicUrl,
      fileName: finalFilename,
      outputType: "pdf"
    });
  } catch (error) {
    console.error("Failed to upload backoffice course file:", error);
    res.status(500).json({ message: "Impossible d'uploader le support" });
  }
});

// Programmation C sub-acquis detail endpoint.
// Returns course files and quiz questions (without answers) for one sub-acquis.
webRouter.get("/api/programmation-c/sub-acquis/:moduleId/:subAcquisId", async (req, res) => {
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

webRouter.get("/api/student/self-evaluation/overview", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }

    const [modules, user] = await Promise.all([
      readPersistedCurriculumModules(),
      User.findOne({ identifier }).select({ progress: 1 }).lean()
    ]);

    if (!user) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const resultsMap = extractSelfEvaluationResults(user);
    const overview = buildSelfEvaluationOverview(modules, resultsMap);

    res.status(200).json({
      passScore: SELF_EVALUATION_PASS_SCORE,
      modules: overview
    });
  } catch (error) {
    console.error("Failed to build self-evaluation overview:", error);
    res.status(500).json({ message: "Impossible de charger les quiz" });
  }
});

webRouter.get("/api/student/self-evaluation/quiz", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
    const moduleId = typeof req.query?.moduleId === "string" ? req.query.moduleId.trim() : "";
    const acquisId = typeof req.query?.acquisId === "string" ? req.query.acquisId.trim() : "";

    if (!identifier || !moduleId || !acquisId) {
      return res.status(400).json({ message: "Identifiant, moduleId et acquisId requis" });
    }

    const [modules, user] = await Promise.all([
      readPersistedCurriculumModules(),
      User.findOne({ identifier }).select({ progress: 1 }).lean()
    ]);

    if (!user) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const resultsMap = extractSelfEvaluationResults(user);
    const overview = buildSelfEvaluationOverview(modules, resultsMap);
    const moduleOverview = overview.find((entry) => entry.moduleId === moduleId);
    const acquisOverview = moduleOverview?.acquis.find((entry) => entry.acquisId === acquisId);

    if (!acquisOverview) {
      return res.status(404).json({ message: "Quiz introuvable" });
    }

    if (!acquisOverview.isUnlocked) {
      return res.status(403).json({ message: "Quiz verrouille" });
    }

    const moduleDoc = modules.find((entry) => String(entry.id) === moduleId);
    const acquisDoc = moduleDoc?.acquis.find((entry) => String(entry.id) === acquisId);
    if (!moduleDoc || !acquisDoc) {
      return res.status(404).json({ message: "Quiz introuvable" });
    }

    const quizQuestions = collectAcquisQuizQuestions(acquisDoc);
    if (!quizQuestions.length) {
      return res.status(404).json({ message: "Quiz introuvable" });
    }

    res.status(200).json({
      moduleId,
      acquisId,
      moduleName: moduleDoc.name || moduleDoc.id,
      acquisName: acquisDoc.name || acquisDoc.id,
      quizQuestions: quizQuestions.map((question) => ({
        prompt: question.prompt,
        options: question.options,
        correctOptionIndex: question.correctOptionIndex
      })),
      quizQuestionCount: quizQuestions.length,
      passScore: SELF_EVALUATION_PASS_SCORE
    });
  } catch (error) {
    console.error("Failed to load self-evaluation quiz:", error);
    res.status(500).json({ message: "Impossible de charger le quiz" });
  }
});

webRouter.post("/api/student/self-evaluation/submit", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? ""; // verified session identity, never a client-supplied value
    const moduleId = typeof req.body?.moduleId === "string" ? req.body.moduleId.trim() : "";
    const acquisId = typeof req.body?.acquisId === "string" ? req.body.acquisId.trim() : "";
    const timeSpent = typeof req.body?.timeSpent === "number" ? req.body.timeSpent : 0;
    const answers = Array.isArray(req.body?.answers)
      ? req.body.answers.map((answer: unknown) =>
          Number.isFinite(Number(answer)) ? Number(answer) : null
        )
      : [];

    if (!identifier || !moduleId || !acquisId) {
      return res.status(400).json({ message: "Identifiant, moduleId et acquisId requis" });
    }

    const [modules, user] = await Promise.all([
      readPersistedCurriculumModules(),
      User.findOne({ identifier })
    ]);

    if (!user) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const resultsMap = extractSelfEvaluationResults(user);
    const overview = buildSelfEvaluationOverview(modules, resultsMap);
    const moduleOverview = overview.find((entry) => entry.moduleId === moduleId);
    const acquisOverview = moduleOverview?.acquis.find((entry) => entry.acquisId === acquisId);

    if (!acquisOverview) {
      return res.status(404).json({ message: "Quiz introuvable" });
    }

    if (!acquisOverview.isUnlocked) {
      return res.status(403).json({ message: "Quiz verrouille" });
    }

    const moduleDoc = modules.find((entry) => String(entry.id) === moduleId);
    const acquisDoc = moduleDoc?.acquis.find((entry) => String(entry.id) === acquisId);
    if (!moduleDoc || !acquisDoc) {
      return res.status(404).json({ message: "Quiz introuvable" });
    }

    const quizQuestions = collectAcquisQuizQuestions(acquisDoc);
    if (!quizQuestions.length) {
      return res.status(404).json({ message: "Quiz introuvable" });
    }

    const { score, correctCount, totalCount } = scoreSelfEvaluationQuestions(quizQuestions, answers);
    const passed = score >= SELF_EVALUATION_PASS_SCORE;
    const xpEarned = passed ? Math.floor(score + timeSpent) : 0;

    const progress = user.progress || { xp: 0, completedLessonKeys: [], quizResults: [], selfEvaluationResults: [] };
    progress.xp = (progress.xp || 0) + xpEarned;
    const currentResults = Array.isArray(progress.selfEvaluationResults)
      ? [...progress.selfEvaluationResults]
      : [];

    const existingIndex = currentResults.findIndex(
      (entry) => entry.moduleId === moduleId && entry.acquisId === acquisId
    );

    const updatedEntry = {
      moduleId,
      acquisId,
      score,
      passed,
      timeSpent,
      xpEarned,
      submittedAt: new Date()
    };

    if (existingIndex >= 0) {
      currentResults[existingIndex] = updatedEntry;
    } else {
      currentResults.push(updatedEntry);
    }

    user.progress = {
      ...progress,
      selfEvaluationResults: currentResults
    };

    await user.save();

    if (xpEarned > 0) {
      await StudentProfile.updateOne({ identifier }, { $inc: { xp: xpEarned } });
    }

    res.status(200).json({
      moduleId,
      acquisId,
      score,
      passed,
      correctCount,
      totalCount,
      passScore: SELF_EVALUATION_PASS_SCORE,
      xpEarned,
      totalXp: progress.xp
    });
  } catch (error) {
    console.error("Failed to submit self-evaluation quiz:", error);
    res.status(500).json({ message: "Impossible de soumettre le quiz" });
  }
});

webRouter.get("/api/student/calendar", requireAuth, async (req, res) => {
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
webRouter.post("/api/programmation-c/sub-acquis/:moduleId/:subAcquisId/submit", requireAuth, async (req, res) => {
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
      remediationTargets
    });
  } catch (error) {
    console.error("Failed to score quiz:", error);
    res.status(400).json({ message: "Impossible de corriger le quiz" });
  }
});

webRouter.post("/api/student/progress/lesson-view", requireAuth, async (req, res) => {
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
webRouter.post("/api/student/vark", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? "";
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
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
webRouter.get("/api/student/vark", requireAuth, async (req, res) => {
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

webRouter.get("/api/student/progress/:identifier", async (req, res) => {
  try {
    const identifier = String(req.params.identifier || "").trim();
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

webRouter.get("/api/student/prediction/:identifier", async (req, res) => {
  try {
    const identifier = String(req.params.identifier || "").trim();
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
webRouter.post("/api/ml/predict", async (req, res) => {
  try {
    const body = req.body ?? {};
    const parsed = {
      delayWeeks:     Number(body.delayWeeks),
      completionPace: Number(body.completionPace),
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

    for (const key of ["delayWeeks", "completionPace", "averageScore", "loginFrequency", "gapDepth"] as const) {
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

webRouter.post("/api/teacher/quizzes/generate", async (req, res) => {
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
webRouter.post("/api/teacher/quizzes/regenerate", async (req, res) => {
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
webRouter.post("/api/teacher/quizzes/validate", async (req, res) => {
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
webRouter.post("/api/teacher/quizzes/reject", async (req, res) => {
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


// ---------------------------------------------------------------------------
// Dashboard — comprehensive student dashboard data
// ---------------------------------------------------------------------------
webRouter.get("/api/student/dashboard/:identifier", async (req, res) => {
  try {
    const identifier = String(req.params.identifier || "").trim();
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
      completionPace: globalFeatures.completionPace,
      xp: Number(progress.xp || 0),
      streak: Math.min(Number(profile?.loginCount || 0), 30),
      totalLessons: stats.lessonsCompleted,
      totalQuizzes: stats.quizzesPassed
    };

    res.status(200).json({
      identifier,
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

/**
 * Builds the chatbot vector store ahead of the first student request so the
 * one-time PDF parsing + embedding cost is paid at boot, not on a live query.
 * Safe to call fire-and-forget; failures are swallowed (the request path falls
 * back to lexical retrieval).
 */
export { webRouter };
