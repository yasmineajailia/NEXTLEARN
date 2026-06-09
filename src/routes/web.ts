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
import { authRouter } from "./auth";
import { User } from "../models/User";
import { Teacher } from "../models/Teacher";
import { ClassRoom } from "../models/ClassRoom";
import { StudentProfile } from "../models/StudentProfile";
import { CurriculumModule } from "../models/CurriculumModule";
import { StudentChatbotVector } from "../models/StudentChatbotVector";
import { StudentRemediationQuiz } from "../models/StudentRemediationQuiz";
import { hashPassword } from "../utils/password";
import { Recommender, type ChapterScoreEntry, type RecommendOptions, type ScoreEntry, type SkillsJson } from "../services/recommendation/skill-recommender.js";
import { env } from "../config/env";
import { MLPredictorService } from "../services/MLPredictorService";

const webRouter = Router();
const publicRoot = path.join(process.cwd(), "public");
const supportRoot = path.join(process.cwd(), "content", "Support_Cours_Préparation");
const generatedQuizzesRoot = path.join(publicRoot, "generated-quizzes");
const recommendationGraphPath = path.join(process.cwd(), "graph.json");
const supportPublicPrefix = "/Support_Cours_Préparation/";
const execFileAsync = promisify(execFile);
const curriculumMediaBucketName = "curriculum-media";
const courseContentSnippetCache = new Map<string, string[]>();
let recommendationGraphCache: SkillsJson | null = null;
const SELF_EVALUATION_PASS_SCORE = 60;

type QuizQuestion = {
  prompt: string;
  options: string[];
  correctOptionIndex: number | null;
};

type QuizJsonPayload = {
  questions?: Array<{
    prompt?: string;
    options?: string[];
    correctOptionIndex?: number | null;
  }>;
};

type CurriculumQuizQuestion = {
  prompt: string;
  options: string[];
  correctAnswerIndex: number | null;
};

type CurriculumQuiz = {
  id: string;
  type: string;
  title: string;
  questions: CurriculumQuizQuestion[];
};

type CurriculumCourseFile = {
  id: string;
  title: string;
  url: string;
  fileType: string;
};

type CurriculumVideo = {
  id: string;
  title: string;
  url: string;
  source: string;
};

type CurriculumSubAcquis = {
  id: string;
  name: string;
  bloomLevel?: string;
  resource?: {
    type?: string;
    ref?: string;
  };
  lessonsCount?: number;
  courseFiles?: CurriculumCourseFile[];
  videos?: CurriculumVideo[];
  quizzes?: CurriculumQuiz[];
};

type CurriculumAcquis = {
  id: string;
  name: string;
  isDefaultBucket?: boolean;
  sousAcquis: CurriculumSubAcquis[];
};

type CurriculumModuleDoc = {
  id: string;
  name: string;
  sortOrder?: number;
  acquis: CurriculumAcquis[];
};

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
type TeacherGeneratedQuestion = {
  prompt: string;
  options: string[];
  correctOptionIndex: number;
  source?: "ai" | "fallback";
};

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

function getCurriculumMediaBucket() {
  if (!mongoose.connection.db) {
    throw new Error("MongoDB connection is not ready");
  }

  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: curriculumMediaBucketName
  });
}

function buildMediaPublicUrl(fileId: string, filename: string): string {
  return `/api/media/${encodeURIComponent(fileId)}/${encodeURIComponent(filename)}`;
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

function inferContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".ogg")) return "video/ogg";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".m4v")) return "video/x-m4v";
  return "application/octet-stream";
}

function extractGridFsFileIdFromMediaUrl(url: string): string | null {
  const match = String(url || "").match(/^\/api\/media\/([^/]+)\//i);
  return match?.[1] || null;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    stream.on("data", (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        return;
      }

      chunks.push(Buffer.from(chunk));
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function readBufferFromCourseFileUrl(url: string): Promise<{ buffer: Buffer; filename: string } | null> {
  const trimmedUrl = String(url || "").trim();
  if (!trimmedUrl || /^https?:\/\//i.test(trimmedUrl)) {
    return null;
  }

  if (trimmedUrl.startsWith("/api/media/")) {
    const fileId = extractGridFsFileIdFromMediaUrl(trimmedUrl);
    if (!fileId || !mongoose.mongo.ObjectId.isValid(fileId)) {
      return null;
    }

    const objectId = new mongoose.mongo.ObjectId(fileId);
    const bucket = getCurriculumMediaBucket();
    const files = await bucket.find({ _id: objectId }).toArray();
    const file = files[0];
    if (!file) {
      return null;
    }

    const stream = bucket.openDownloadStream(objectId);
    const buffer = await streamToBuffer(stream);
    return {
      buffer,
      filename: String(file.filename || "support.pdf")
    };
  }

  if (trimmedUrl.startsWith("/")) {
    const absolutePath = resolveLocalPathFromPublicUrl(trimmedUrl);
    if (!absolutePath) {
      return null;
    }

    const buffer = await fs.readFile(absolutePath);
    return {
      buffer,
      filename: path.basename(absolutePath)
    };
  }

  return null;
}

function normalizeCourseExtractedText(value: string): string {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\t+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

function splitTextIntoRagSnippets(text: string, maxChars = 900, maxSnippets = 3): string[] {
  const paragraphs = normalizeCourseExtractedText(text)
    .split(/\n\n+/)
    .map((entry) => normalizeWhitespace(entry))
    .filter((entry) => entry.length >= 40);

  const snippets: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    if (`${current}\n${paragraph}`.length <= maxChars) {
      current = `${current}\n${paragraph}`;
      continue;
    }

    snippets.push(current);
    if (snippets.length >= maxSnippets) {
      return snippets;
    }

    current = paragraph;
  }

  if (current && snippets.length < maxSnippets) {
    snippets.push(current);
  }

  return snippets;
}

async function extractCourseContentSnippetsFromUrl(url: string): Promise<string[]> {
  const cacheKey = String(url || "").trim();
  if (!cacheKey) {
    return [];
  }

  const cached = courseContentSnippetCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const filePayload = await readBufferFromCourseFileUrl(cacheKey);
    if (!filePayload) {
      courseContentSnippetCache.set(cacheKey, []);
      return [];
    }

    const extension = path.extname(filePayload.filename).toLowerCase();
    if (extension !== ".pdf") {
      courseContentSnippetCache.set(cacheKey, []);
      return [];
    }

    const parser = new PDFParse({ data: filePayload.buffer });
    const parsed = await parser.getText();
    await parser.destroy().catch(() => undefined);
    const snippets = splitTextIntoRagSnippets(String(parsed.text || ""));
    courseContentSnippetCache.set(cacheKey, snippets);
    return snippets;
  } catch (error) {
    console.warn("Failed to extract course content from support file:", cacheKey, error);
    courseContentSnippetCache.set(cacheKey, []);
    return [];
  }
}

async function uploadBufferToGridFs(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ fileId: string; publicUrl: string }> {
  const bucket = getCurriculumMediaBucket();
  const contentType = params.contentType || inferContentType(params.filename);
  const uploadStream = bucket.openUploadStream(params.filename, {
    metadata: {
      ...(params.metadata || {}),
      contentType
    }
  });

  await new Promise<void>((resolve, reject) => {
    uploadStream.on("finish", () => resolve());
    uploadStream.on("error", reject);
    Readable.from(params.buffer).pipe(uploadStream);
  });

  const fileId = uploadStream.id.toString();
  return {
    fileId,
    publicUrl: buildMediaPublicUrl(fileId, params.filename)
  };
}

async function mirrorPublicFileToGridFs(publicUrl: string, metadata: Record<string, unknown>): Promise<{ url: string; title: string; fileType: string }> {
  if (/^https?:\/\//i.test(publicUrl)) {
    return {
      url: publicUrl,
      title: path.basename(new URL(publicUrl).pathname) || "media",
      fileType: inferContentType(publicUrl)
    };
  }

  const absolutePath = resolveLocalPathFromPublicUrl(publicUrl);
  if (!absolutePath) {
    throw new Error("Unable to resolve local media path from URL.");
  }

  const buffer = await fs.readFile(absolutePath);
  const filename = path.basename(absolutePath);
  const uploadResult = await uploadBufferToGridFs({
    buffer,
    filename,
    contentType: inferContentType(filename),
    metadata
  });

  return {
    url: uploadResult.publicUrl,
    title: path.basename(filename, path.extname(filename)) || filename,
    fileType: inferContentType(filename)
  };
}

function isLocalMediaUrl(url: string): boolean {
  return Boolean(url) && url.startsWith("/") && !url.startsWith("/api/media/") && !url.startsWith("/api/");
}

function canonicalMediaKey(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw, "http://localhost");
    const fullName = decodeURIComponent(path.basename(parsed.pathname || "")).toLowerCase();
    const ext = path.extname(fullName);
    return fullName.slice(0, Math.max(0, fullName.length - ext.length));
  } catch (_error) {
    const fullName = path.basename(raw).toLowerCase();
    const ext = path.extname(fullName);
    return fullName.slice(0, Math.max(0, fullName.length - ext.length));
  }
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

function moduleDocToOverview(moduleDoc: CurriculumModuleDoc): {
  id: string;
  name: string;
  sortOrder: number;
  subAcquisCount: number;
  subAcquis: Array<{ id: string; name: string; hasQuiz: boolean; hasVideo: boolean }>;
} {
  const subAcquis = moduleDoc.acquis.flatMap((acquis) =>
    acquis.sousAcquis.map((entry) => ({
      id: entry.id,
      name: entry.name || entry.id,
      hasQuiz: Array.isArray(entry.quizzes) && entry.quizzes.length > 0,
      hasVideo:
        (Array.isArray(entry.videos) && entry.videos.length > 0) ||
        Boolean(entry.resource?.ref)
    }))
  );

  return {
    id: moduleDoc.id,
    name: moduleDoc.name || moduleDoc.id,
    sortOrder: Number.isFinite(Number(moduleDoc.sortOrder)) ? Number(moduleDoc.sortOrder) : 0,
    subAcquisCount: subAcquis.length,
    subAcquis
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
  const persistedByModule = new Map<string, Set<string>>();

  for (const moduleDoc of persistedModules) {
    const moduleId = String(moduleDoc.id || "").trim();
    if (!moduleId) {
      continue;
    }

    persistedByModule.set(moduleId, new Set(listSubAcquisIds(moduleDoc)));
  }

  for (const moduleEntry of filesystemOverview) {
    const persistedSubAcquis = persistedByModule.get(moduleEntry.id);
    if (!persistedSubAcquis) {
      return true;
    }

    for (const subAcquis of moduleEntry.subAcquis) {
      if (!persistedSubAcquis.has(subAcquis.id)) {
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForComparison(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase();
}

function normalizeForLookup(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function stripTrailingLevelNumber(value: string): string {
  return String(value || "")
    .replace(/\s+\d+\s*$/, "")
    .trim();
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

function resolveLocalPathFromPublicUrl(url: string): string | null {
  const relativePath = url.startsWith("/") ? url.slice(1) : url;
  if (!relativePath) {
    return null;
  }

  const supportPrefix = supportPublicPrefix.slice(1);
  if (relativePath.startsWith(supportPrefix)) {
    const supportRelative = relativePath.slice(supportPrefix.length);
    return path.join(supportRoot, supportRelative);
  }

  return path.join(publicRoot, relativePath);
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

function buildLessonKey(moduleId: string, subAcquisId: string): string {
  return `${moduleId}::${subAcquisId}`;
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

function computeStudentProgress(progress: unknown): {
  lessonsCompleted: number;
  quizzesPassed: number;
  averageQuizScoreOn20: number;
} {
  const progressRecord = (progress ?? {}) as {
    completedLessonKeys?: unknown;
    quizResults?: Array<{ score?: unknown }>;
  };

  const completedLessonKeys = Array.isArray(progressRecord.completedLessonKeys)
    ? progressRecord.completedLessonKeys.filter((entry): entry is string => typeof entry === "string")
    : [];

  const quizResults = Array.isArray(progressRecord.quizResults)
    ? progressRecord.quizResults
        .map((entry) => {
          const score = Number(entry?.score);
          return Number.isFinite(score) ? score : NaN;
        })
        .filter((score) => Number.isFinite(score))
    : [];

  const averagePercent =
    quizResults.length > 0 ? quizResults.reduce((sum, score) => sum + score, 0) / quizResults.length : 0;

  return {
    lessonsCompleted: completedLessonKeys.length,
    quizzesPassed: quizResults.length,
    averageQuizScoreOn20: Math.round((averagePercent / 5) * 10) / 10
  };
}

type SubAcquisOverview = {
  id: string;
  name: string;
  hasQuiz: boolean;
  hasVideo: boolean;
};

type ModuleOverview = {
  id: string;
  name: string;
  sortOrder: number;
  subAcquisCount: number;
  subAcquis: SubAcquisOverview[];
};

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

async function readPersistedCurriculumModules(): Promise<CurriculumModuleDoc[]> {
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
}

async function readPersistedProgramCOverview(): Promise<ModuleOverview[]> {
  const modules = await readPersistedCurriculumModules();
  return modules.map(moduleDocToOverview);
}

type ClassAccessContext = {
  classId: string;
  accessByModule: Record<string, string>;
  scheduleStartDate: string | null;
  accessScheduleBySubAcquis: Record<string, string>;
};

type StudentCalendarEntry = {
  moduleId: string;
  moduleName: string;
  subAcquisId: string;
  subAcquisName: string;
  unlockAt: string | null;
  unlocked: boolean;
};

const SCHEDULE_KEY_DOT_TOKEN = "__dot__";

function encodeScheduleStorageKey(subAcquisId: string): string {
  return String(subAcquisId || "").replace(/\./g, SCHEDULE_KEY_DOT_TOKEN);
}

function decodeScheduleStorageKey(storedKey: string): string {
  return String(storedKey || "").replace(new RegExp(SCHEDULE_KEY_DOT_TOKEN, "g"), ".");
}

function toAccessRecord(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }

  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value.entries()).map(([key, rule]) => [String(key), String(rule)]));
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, rule]) => {
      acc[String(key)] = String(rule || "");
      return acc;
    }, {});
  }

  return {};
}

function toDateIsoRecord(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }

  const collectEntries = value instanceof Map
    ? Array.from(value.entries())
    : typeof value === "object"
      ? Object.entries(value as Record<string, unknown>)
      : [];

  return collectEntries.reduce<Record<string, string>>((acc, [rawKey, rawValue]) => {
    const key = String(rawKey || "").trim();
    if (!key) {
      return acc;
    }

    const date = rawValue instanceof Date ? rawValue : new Date(String(rawValue || ""));
    if (Number.isNaN(date.getTime())) {
      return acc;
    }

    acc[key] = date.toISOString();
    return acc;
  }, {});
}

function toScheduleIsoRecord(value: unknown): Record<string, string> {
  const rawRecord = toDateIsoRecord(value);
  return Object.entries(rawRecord).reduce<Record<string, string>>((acc, [storedKey, isoValue]) => {
    acc[decodeScheduleStorageKey(storedKey)] = isoValue;
    return acc;
  }, {});
}

function toIsoDateOrNull(value: unknown): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function isModuleBlocked(accessByModule: Record<string, string>, moduleId: string): boolean {
  return String(accessByModule[moduleId] || "").toLowerCase() === "blocked";
}

function isSubAcquisUnlocked(accessScheduleBySubAcquis: Record<string, string>, subAcquisId: string): boolean {
  const unlockAt = String(accessScheduleBySubAcquis[subAcquisId] || "").trim();
  if (!unlockAt) {
    return true;
  }

  const unlockDate = new Date(unlockAt);
  if (Number.isNaN(unlockDate.getTime())) {
    return true;
  }

  return unlockDate.getTime() <= Date.now();
}

function hasScheduledUnlock(accessScheduleBySubAcquis: Record<string, string>, subAcquisId: string): boolean {
  return Boolean(String(accessScheduleBySubAcquis[subAcquisId] || "").trim());
}

function isSubAcquisAccessibleByAccessRules(
  access: ClassAccessContext | null,
  moduleId: string,
  subAcquisId: string
): boolean {
  if (!access) {
    return true;
  }

  const moduleBlocked = isModuleBlocked(access.accessByModule, moduleId);
  const scheduled = hasScheduledUnlock(access.accessScheduleBySubAcquis, subAcquisId);

  // When a schedule exists, the unlock date is authoritative for students.
  if (scheduled) {
    return isSubAcquisUnlocked(access.accessScheduleBySubAcquis, subAcquisId);
  }

  return !moduleBlocked;
}

function filterOverviewByAccess(overview: ModuleOverview[], access: ClassAccessContext | null): ModuleOverview[] {
  if (!access) {
    return overview;
  }

  return overview
    .map((moduleData) => {
      const filteredSubAcquis = moduleData.subAcquis.filter((entry) =>
        isSubAcquisAccessibleByAccessRules(access, moduleData.id, entry.id)
      );

      if (!filteredSubAcquis.length) {
        return null;
      }

      return {
        ...moduleData,
        subAcquisCount: filteredSubAcquis.length,
        subAcquis: filteredSubAcquis
      };
    })
    .filter((moduleData): moduleData is ModuleOverview => Boolean(moduleData));
}

function toStudentCalendarEntries(overview: ModuleOverview[], access: ClassAccessContext | null): StudentCalendarEntry[] {
  const entries = overview.flatMap((moduleData) => {
    return moduleData.subAcquis.map((subAcquis) => {
      const unlockAt = access ? access.accessScheduleBySubAcquis[subAcquis.id] || null : null;
      const accessible = isSubAcquisAccessibleByAccessRules(access, moduleData.id, subAcquis.id);

      return {
        moduleId: moduleData.id,
        moduleName: moduleData.name,
        subAcquisId: subAcquis.id,
        subAcquisName: subAcquis.name,
        unlockAt,
        unlocked: accessible
      };
    });
  });

  return entries.sort((a, b) => {
    const aDate = a.unlockAt ? new Date(a.unlockAt).getTime() : 0;
    const bDate = b.unlockAt ? new Date(b.unlockAt).getTime() : 0;
    return aDate - bDate;
  });
}

function parseCalendarWeekMap(text: string): Record<string, number> {
  const mapping: Record<string, number> = {};

  const normalizeCalendarSubAcquisId = (rawValue: string): string => {
    const compact = String(rawValue || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/\.$/, "");
    const match = compact.match(/^(\d+)\.(\d+)$/);
    return match ? `${match[1]}.${match[2]}` : compact;
  };

  String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/^(\d+\.\d+)\s*:\s*semaine\s*(\d+)\s*$/i);
      if (!match) {
        return;
      }

      const subAcquisId = normalizeCalendarSubAcquisId(String(match[1] || ""));
      const weekNumber = Number(match[2]);
      if (!subAcquisId || !Number.isFinite(weekNumber) || weekNumber < 1) {
        return;
      }

      mapping[subAcquisId] = weekNumber;
    });

  return mapping;
}

async function readCalendarWeekMapFromFile(): Promise<Record<string, number>> {
  try {
    const calendarPath = path.join(process.cwd(), "data", "calendar.txt");
    const raw = await fs.readFile(calendarPath, "utf8");
    return parseCalendarWeekMap(raw);
  } catch (_error) {
    return {};
  }
}

function parseStartDateInput(rawValue: string): Date | null {
  const value = String(rawValue || "").trim();
  if (!value) {
    return null;
  }

  const ymdMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const month = Number(ymdMatch[2]) - 1;
    const day = Number(ymdMatch[3]);
    const utcDate = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
    return Number.isNaN(utcDate.getTime()) ? null : utcDate;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 0, 0, 0, 0));
}

function buildScheduleBySubAcquis(params: {
  overview: ModuleOverview[];
  weekMap: Record<string, number>;
  startDate: Date;
}): Record<string, string> {
  const { overview, weekMap, startDate } = params;
  const schedule: Record<string, string> = {};

  const normalizeCalendarSubAcquisId = (rawValue: string): string => {
    const compact = String(rawValue || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/\.$/, "");
    const match = compact.match(/^(\d+)\.(\d+)$/);
    return match ? `${match[1]}.${match[2]}` : compact;
  };

  overview.forEach((moduleData) => {
    moduleData.subAcquis.forEach((subAcquis) => {
      const normalizedSubAcquisId = normalizeCalendarSubAcquisId(subAcquis.id);
      const weekNumber = Number(weekMap[normalizedSubAcquisId] || weekMap[subAcquis.id] || 1);
      const safeWeek = Number.isFinite(weekNumber) && weekNumber > 0 ? weekNumber : 1;
      const unlockDate = new Date(startDate.getTime() + (safeWeek - 1) * 7 * 24 * 60 * 60 * 1000);
      schedule[subAcquis.id] = unlockDate.toISOString();
    });
  });

  return schedule;
}

async function readClassAccessByStudentIdentifier(identifier: string): Promise<ClassAccessContext | null> {
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
webRouter.get("/", (_req, res) => {
  const indexPath = path.join(process.cwd(), "public", "index.html");
  res.sendFile(indexPath);
});

// Programmation C page endpoint.
webRouter.get("/programmation-c", (_req, res) => {
  const programmationCPath = path.join(process.cwd(), "public", "student", "programmation-c.html");
  res.sendFile(programmationCPath);
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
    const identifier = typeof req.query?.identifier === "string" ? req.query.identifier.trim() : "";
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

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.filename || req.params.filename)}"`);

    const downloadStream = bucket.openDownloadStream(objectId);
    downloadStream.on("error", (error) => {
      console.error("Failed to stream media file:", error);
      if (!res.headersSent) {
        res.status(500).end("Failed to stream file");
      } else {
        res.end();
      }
    });

    downloadStream.pipe(res);
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
    const identifier = typeof req.query?.identifier === "string" ? req.query.identifier.trim() : "";
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

    res.status(200).json({
      moduleId,
      subAcquisId,
      moduleName: resources.moduleName,
      subAcquisName: resources.subAcquisName,
      courseFiles: resources.pptFiles,
      videoFiles: resources.videoFiles,
      quizQuestions: publicQuestions,
      quizQuestionCount: publicQuestions.length,
      ...remediationMeta
    });
  } catch (error) {
    console.error("Failed to read sub-acquis resources:", error);
    res.status(404).json({ message: "Sous-acquis introuvable" });
  }
});

webRouter.get("/api/student/self-evaluation/overview", async (req, res) => {
  try {
    const identifier = typeof req.query?.identifier === "string" ? req.query.identifier.trim() : "";
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

webRouter.get("/api/student/self-evaluation/quiz", async (req, res) => {
  try {
    const identifier = typeof req.query?.identifier === "string" ? req.query.identifier.trim() : "";
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

webRouter.post("/api/student/self-evaluation/submit", async (req, res) => {
  try {
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
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

webRouter.get("/api/student/calendar", async (req, res) => {
  try {
    const identifier = typeof req.query?.identifier === "string" ? req.query.identifier.trim() : "";
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

type StudentRagChunk = {
  moduleId: string;
  moduleName: string;
  subAcquisId: string | null;
  subAcquisName: string | null;
  kind: "module" | "sub-acquis" | "quiz" | "video" | "course-file" | "course-content";
  text: string;
  tokens: string[];
};

type StudentVectorChunk = StudentRagChunk & {
  chunkId: string;
  contentHash: string;
  embedding?: number[];
};

function hasEmbeddingProvider(): boolean {
  return Boolean(env.geminiApiKey || env.openaiApiKey);
}

function hashStudentVectorText(value: string): string {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function buildStudentVectorChunkId(chunk: StudentRagChunk): string {
  const subKey = chunk.subAcquisId || "module";
  return hashStudentVectorText(`${chunk.moduleId}|${subKey}|${chunk.kind}|${chunk.text}`);
}

function normalizeVector(values: number[]): number[] {
  const sumSquares = values.reduce((sum, value) => sum + value * value, 0);
  const magnitude = Math.sqrt(sumSquares);
  if (!magnitude) {
    return values;
  }

  return values.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (!length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] || 0;
    const rightValue = right[index] || 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

async function fetchOpenAiEmbeddings(texts: string[]): Promise<number[][]> {
  if (!env.openaiApiKey) {
    throw new Error("OpenAI embeddings are not configured");
  }

  const response = await fetch(`${env.openaiEmbeddingBaseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.openaiEmbeddingModel,
      input: texts
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Embedding request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
  };

  const ordered = Array.isArray(payload.data)
    ? payload.data
        .map((item, index) => ({
          index: typeof item.index === "number" ? item.index : index,
          embedding: Array.isArray(item.embedding) ? item.embedding : []
        }))
        .sort((left, right) => left.index - right.index)
        .map((item) => item.embedding)
    : [];

  if (ordered.length !== texts.length) {
    throw new Error("Embedding response size mismatch");
  }

  return ordered;
}

async function fetchGeminiEmbeddings(texts: string[]): Promise<number[][]> {
  if (!env.geminiApiKey) {
    throw new Error("Gemini embeddings are not configured");
  }

  const embeddingModelName = await resolveGeminiModelForMethod(
    "embedContent",
    env.geminiEmbeddingModel,
    ["text-embedding-004", "embedding-001"]
  );

  const embeddings: number[][] = [];
  for (const text of texts) {
    const response = await fetch(
      `${env.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(embeddingModelName)}:embedContent?key=${encodeURIComponent(env.geminiApiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: {
            parts: [{ text }]
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Gemini embedding request failed (${response.status}): ${errorText}`);
    }

    const payload = (await response.json()) as {
      embedding?: {
        values?: number[];
      };
    };

    embeddings.push(Array.isArray(payload.embedding?.values) ? payload.embedding.values : []);
  }

  return embeddings;
}

type GeminiModelEntry = {
  name?: string;
  supportedGenerationMethods?: string[];
};

let geminiModelCatalogCache: GeminiModelEntry[] | null = null;

function normalizeGeminiModelName(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^models\//i, "");
}

async function listGeminiModels(): Promise<GeminiModelEntry[]> {
  if (!env.geminiApiKey) {
    return [];
  }

  if (geminiModelCatalogCache) {
    return geminiModelCatalogCache;
  }

  const response = await fetch(
    `${env.geminiBaseUrl.replace(/\/$/, "")}/models?key=${encodeURIComponent(env.geminiApiKey)}`,
    {
      method: "GET"
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Gemini ListModels failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    models?: GeminiModelEntry[];
  };

  geminiModelCatalogCache = Array.isArray(payload.models) ? payload.models : [];
  return geminiModelCatalogCache;
}

async function resolveGeminiModelForMethod(
  method: "generateContent" | "embedContent",
  preferredModel: string,
  fallbackCandidates: string[]
): Promise<string> {
  const models = await listGeminiModels();
  const supportsMethod = (entry: GeminiModelEntry): boolean =>
    Array.isArray(entry.supportedGenerationMethods) && entry.supportedGenerationMethods.includes(method);
  const modelSet = new Set(
    models
      .filter((entry) => supportsMethod(entry) && typeof entry.name === "string")
      .map((entry) => normalizeGeminiModelName(String(entry.name || "")))
      .filter(Boolean)
  );

  const normalizedPreferred = normalizeGeminiModelName(preferredModel);
  if (normalizedPreferred && modelSet.has(normalizedPreferred)) {
    return normalizedPreferred;
  }

  for (const candidate of fallbackCandidates) {
    const normalizedCandidate = normalizeGeminiModelName(candidate);
    if (modelSet.has(normalizedCandidate)) {
      return normalizedCandidate;
    }
  }

  const firstCompatible = models.find((entry) => {
    if (!supportsMethod(entry) || typeof entry.name !== "string") {
      return false;
    }

    const normalized = normalizeGeminiModelName(entry.name);
    return method === "embedContent"
      ? normalized.includes("embed") || normalized.includes("embedding")
      : normalized.includes("gemini");
  });

  if (firstCompatible?.name) {
    return normalizeGeminiModelName(firstCompatible.name);
  }

  throw new Error(`No Gemini model supports ${method} in the current account/API version.`);
}

async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  if (env.geminiApiKey) {
    return fetchGeminiEmbeddings(texts);
  }

  return fetchOpenAiEmbeddings(texts);
}

async function ensureStudentVectorStore(persistedModules: CurriculumModuleDoc[]): Promise<boolean> {
  if (!hasEmbeddingProvider()) {
    return false;
  }

  const corpus = (await buildStudentRagIndex({
    accessibleOverview: persistedModules.map(moduleDocToOverview),
    persistedModules
  })).map((chunk) => ({
    ...chunk,
    chunkId: buildStudentVectorChunkId(chunk),
    contentHash: hashStudentVectorText(chunk.text)
  }));

  const chunkIds = corpus.map((chunk) => chunk.chunkId);
  const existing = await StudentChatbotVector.find({ chunkId: { $in: chunkIds } })
    .select({ chunkId: 1, contentHash: 1 })
    .lean();
  const existingMap = new Map(existing.map((entry) => [String(entry.chunkId), String(entry.contentHash)]));

  const chunksToEmbed = corpus.filter((chunk) => existingMap.get(chunk.chunkId) !== chunk.contentHash);
  const batchSize = 32;

  for (let index = 0; index < chunksToEmbed.length; index += batchSize) {
    const batch = chunksToEmbed.slice(index, index + batchSize);
    const embeddings = await fetchEmbeddings(batch.map((chunk) => chunk.text));

    const operations = batch.map((chunk, batchIndex) => ({
      updateOne: {
        filter: { chunkId: chunk.chunkId },
        update: {
          $set: {
            chunkId: chunk.chunkId,
            moduleId: chunk.moduleId,
            moduleName: chunk.moduleName,
            subAcquisId: chunk.subAcquisId,
            subAcquisName: chunk.subAcquisName,
            kind: chunk.kind,
            text: chunk.text,
            contentHash: chunk.contentHash,
            embedding: normalizeVector(embeddings[batchIndex] || [])
          }
        },
        upsert: true
      }
    }));

    if (operations.length) {
      await StudentChatbotVector.bulkWrite(operations);
    }
  }

  const storedChunkIds = new Set(chunkIds);
  if (storedChunkIds.size) {
    await StudentChatbotVector.deleteMany({ chunkId: { $nin: chunkIds } });
  }

  return true;
}

async function getStudentVectorMatches(params: {
  persistedModules: CurriculumModuleDoc[];
  accessibleOverview: ModuleOverview[];
  question: string;
  filterToModuleId?: string;
  filterToSubAcquisId?: string;
}): Promise<StudentRagChunk[]> {
  const { persistedModules, accessibleOverview, question, filterToModuleId, filterToSubAcquisId } = params;
  let allowedModuleIds = new Set(accessibleOverview.map((entry) => entry.id));
  let allowedSubAcquisIds = new Set(
    accessibleOverview.flatMap((entry) => entry.subAcquis.map((sub) => `${entry.id}::${sub.id}`))
  );

  // Narrow to a specific module when provided.
  if (filterToModuleId) {
    allowedModuleIds = new Set([filterToModuleId]);
    allowedSubAcquisIds = new Set(
      [...allowedSubAcquisIds].filter((entry) => entry.startsWith(`${filterToModuleId}::`))
    );
  }

  // Narrow further to a specific sub-skill when both filters are provided.
  if (filterToModuleId && filterToSubAcquisId) {
    allowedSubAcquisIds = new Set([`${filterToModuleId}::${filterToSubAcquisId}`]);
  }

  const fallbackToLegacy = async () => {
    const ragIndex = (await buildStudentRagIndex({ accessibleOverview, persistedModules })).filter((chunk) => {
      if (!allowedModuleIds.has(chunk.moduleId)) {
        return false;
      }

      if (!chunk.subAcquisId) {
        return true;
      }

      return allowedSubAcquisIds.has(`${chunk.moduleId}::${chunk.subAcquisId}`);
    });
    const queryNormalized = normalizeForLookup(question);
    const queryTokens = tokenizeForStudentRag(question);

    return ragIndex
      .map((chunk) => ({
        chunk,
        score: scoreStudentRagChunk(chunk, queryNormalized, queryTokens)
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((entry) => entry.chunk);
  };

  try {
    const vectorStoreReady = await ensureStudentVectorStore(persistedModules);

    if (!vectorStoreReady) {
      return fallbackToLegacy();
    }

    const queryEmbedding = normalizeVector((await fetchEmbeddings([question]))[0] || []);
    const docs = await StudentChatbotVector.find({ moduleId: { $in: [...allowedModuleIds] } }).lean();

    const ranked = docs
      .map((doc) => ({
        doc,
        score:
          (doc.subAcquisId ? allowedSubAcquisIds.has(`${doc.moduleId}::${doc.subAcquisId}`) : true)
            ? cosineSimilarity(queryEmbedding, normalizeVector(Array.isArray(doc.embedding) ? doc.embedding : []))
            : 0
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    return ranked.map(({ doc }) => ({
      moduleId: String(doc.moduleId),
      moduleName: String(doc.moduleName || doc.moduleId),
      subAcquisId: doc.subAcquisId ? String(doc.subAcquisId) : null,
      subAcquisName: doc.subAcquisName ? String(doc.subAcquisName) : null,
      kind: doc.kind,
      text: String(doc.text || ""),
      tokens: tokenizeForStudentRag(String(doc.text || ""))
    }));
  } catch (error) {
    console.warn("Vector chatbot retrieval failed; using legacy retrieval fallback:", error);
    return fallbackToLegacy();
  }
}

async function evaluateQuestionAgainstScopedModule(params: {
  persistedModules: CurriculumModuleDoc[];
  accessibleOverview: ModuleOverview[];
  question: string;
  targetModuleId: string;
}): Promise<{
  usedEmbeddings: boolean;
  accepted: boolean;
  targetScore: number;
  topModuleId: string | null;
  topScore: number;
}> {
  const { persistedModules, accessibleOverview, question, targetModuleId } = params;

  if (!hasEmbeddingProvider()) {
    return {
      usedEmbeddings: false,
      accepted: true,
      targetScore: 0,
      topModuleId: null,
      topScore: 0
    };
  }

  try {
    const vectorStoreReady = await ensureStudentVectorStore(persistedModules);
    if (!vectorStoreReady) {
      return {
        usedEmbeddings: false,
        accepted: true,
        targetScore: 0,
        topModuleId: null,
        topScore: 0
      };
    }

    const allowedModuleIds = accessibleOverview.map((entry) => entry.id);
    const docs = await StudentChatbotVector.find({ moduleId: { $in: allowedModuleIds } }).lean();
    const queryEmbedding = normalizeVector((await fetchEmbeddings([question]))[0] || []);

    const moduleBestScore = new Map<string, number>();
    for (const doc of docs) {
      const moduleId = String(doc.moduleId || "");
      if (!moduleId) {
        continue;
      }

      const score = cosineSimilarity(queryEmbedding, normalizeVector(Array.isArray(doc.embedding) ? doc.embedding : []));
      const currentBest = moduleBestScore.get(moduleId) || 0;
      if (score > currentBest) {
        moduleBestScore.set(moduleId, score);
      }
    }

    let topModuleId: string | null = null;
    let topScore = 0;
    for (const [moduleId, score] of moduleBestScore.entries()) {
      if (score > topScore) {
        topScore = score;
        topModuleId = moduleId;
      }
    }

    const targetScore = moduleBestScore.get(targetModuleId) || 0;

    // Hard floor + relative comparison with the best matching module.
    const minAbsoluteScore = 0.2;
    const minRelativeToTop = 0.85;
    const accepted =
      targetScore >= minAbsoluteScore &&
      (topScore <= 0 || targetModuleId === topModuleId || targetScore >= topScore * minRelativeToTop);

    return {
      usedEmbeddings: true,
      accepted,
      targetScore,
      topModuleId,
      topScore
    };
  } catch (error) {
    console.warn("Embedding scope-evaluation failed; falling back to lexical guard:", error);
    return {
      usedEmbeddings: false,
      accepted: true,
      targetScore: 0,
      topModuleId: null,
      topScore: 0
    };
  }
}

function tokenizeForStudentRag(value: string): string[] {
  const stopwords = new Set([
    "le",
    "la",
    "les",
    "de",
    "des",
    "du",
    "un",
    "une",
    "et",
    "ou",
    "dans",
    "sur",
    "pour",
    "avec",
    "que",
    "qui",
    "quoi",
    "est",
    "sous",
    "acquis",
    "module"
  ]);

  const normalized = normalizeForLookup(String(value || ""));
  return normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopwords.has(token));
}

async function buildStudentRagIndex(params: {
  accessibleOverview: ModuleOverview[];
  persistedModules: CurriculumModuleDoc[];
}): Promise<StudentRagChunk[]> {
  const { accessibleOverview, persistedModules } = params;
  const allowedModuleIds = new Set(accessibleOverview.map((entry) => entry.id));
  const allowedSubAcquisIds = new Set(
    accessibleOverview.flatMap((entry) => entry.subAcquis.map((sub) => `${entry.id}::${sub.id}`))
  );

  const chunks: StudentRagChunk[] = [];
  for (const moduleData of accessibleOverview) {
    const moduleText = `Module ${moduleData.id}: ${moduleData.name}`;
    chunks.push({
      moduleId: moduleData.id,
      moduleName: moduleData.name,
      subAcquisId: null,
      subAcquisName: null,
      kind: "module",
      text: moduleText,
      tokens: tokenizeForStudentRag(moduleText)
    });
  }

  for (const moduleDoc of persistedModules) {
    if (!allowedModuleIds.has(moduleDoc.id)) {
      continue;
    }

    const moduleName = String(moduleDoc.name || moduleDoc.id);
    const subAcquisList = (Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : []).flatMap((acquis) =>
      Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : []
    );

    for (const subAcquis of subAcquisList) {
      const accessKey = `${moduleDoc.id}::${subAcquis.id}`;
      if (!allowedSubAcquisIds.has(accessKey)) {
        continue;
      }

      const subName = String(subAcquis.name || subAcquis.id);
      const header = `${moduleDoc.id}.${subAcquis.id} ${moduleName} ${subName}`;
      chunks.push({
        moduleId: moduleDoc.id,
        moduleName,
        subAcquisId: subAcquis.id,
        subAcquisName: subName,
        kind: "sub-acquis",
        text: header,
        tokens: tokenizeForStudentRag(header)
      });

      const quizPrompts = (Array.isArray(subAcquis.quizzes) ? subAcquis.quizzes : []).flatMap((quiz) =>
        Array.isArray(quiz.questions) ? quiz.questions.map((question) => question.prompt).filter(Boolean) : []
      );
      for (const prompt of quizPrompts.slice(0, 4)) {
        const quizText = `Quiz ${subAcquis.id}: ${String(prompt || "").trim()}`;
        chunks.push({
          moduleId: moduleDoc.id,
          moduleName,
          subAcquisId: subAcquis.id,
          subAcquisName: subName,
          kind: "quiz",
          text: quizText,
          tokens: tokenizeForStudentRag(quizText)
        });
      }

      const videos = Array.isArray(subAcquis.videos) ? subAcquis.videos : [];
      for (const video of videos.slice(0, 3)) {
        const videoText = `Video ${subAcquis.id}: ${String(video.title || "").trim()}`;
        chunks.push({
          moduleId: moduleDoc.id,
          moduleName,
          subAcquisId: subAcquis.id,
          subAcquisName: subName,
          kind: "video",
          text: videoText,
          tokens: tokenizeForStudentRag(videoText)
        });
      }

      const courseFiles = Array.isArray(subAcquis.courseFiles) ? subAcquis.courseFiles : [];
      for (const file of courseFiles.slice(0, 3)) {
        const fileText = `Support ${subAcquis.id}: ${String(file.title || file.id || "").trim()}`;
        chunks.push({
          moduleId: moduleDoc.id,
          moduleName,
          subAcquisId: subAcquis.id,
          subAcquisName: subName,
          kind: "course-file",
          text: fileText,
          tokens: tokenizeForStudentRag(fileText)
        });

        const snippets = await extractCourseContentSnippetsFromUrl(String(file.url || ""));
        for (const snippet of snippets.slice(0, 2)) {
          const contentText = `Contenu support ${subAcquis.id} (${String(file.title || file.id || "support").trim()}): ${snippet}`;
          chunks.push({
            moduleId: moduleDoc.id,
            moduleName,
            subAcquisId: subAcquis.id,
            subAcquisName: subName,
            kind: "course-content",
            text: contentText,
            tokens: tokenizeForStudentRag(contentText)
          });
        }
      }
    }
  }

  return chunks;
}

function scoreStudentRagChunk(chunk: StudentRagChunk, query: string, queryTokens: string[]): number {
  if (!queryTokens.length) {
    return 0;
  }

  const chunkTokenSet = new Set(chunk.tokens);
  let overlap = 0;
  for (const token of queryTokens) {
    if (chunkTokenSet.has(token)) {
      overlap += 1;
    }
  }

  if (overlap === 0) {
    return 0;
  }

  const exactLikeBoost = normalizeForLookup(chunk.text).includes(query) ? 2 : 0;
  const kindWeight =
    chunk.kind === "sub-acquis" ? 1.6 :
    chunk.kind === "course-content" ? 1.5 :
    chunk.kind === "quiz" ? 1.4 :
    chunk.kind === "module" ? 1.2 : 1.0;

  const coverage = overlap / Math.max(1, queryTokens.length);
  return coverage * 8 * kindWeight + overlap + exactLikeBoost;
}

function refineStudentRagChunks(question: string, chunks: StudentRagChunk[]): StudentRagChunk[] {
  if (!chunks.length) {
    return [];
  }

  const normalized = normalizeForLookup(question);
  const asksQuiz =
    normalized.includes("quiz") ||
    normalized.includes("question") ||
    normalized.includes("qcm") ||
    normalized.includes("exercice");
  const asksVideo = normalized.includes("video") || normalized.includes("vidéo");

  // For conceptual questions, prioritize course structure chunks over quiz noise.
  const preferredKinds = new Set<StudentRagChunk["kind"]>(
    asksQuiz
      ? ["quiz", "course-content", "sub-acquis", "module", "course-file", "video"]
      : asksVideo
        ? ["video", "course-content", "sub-acquis", "module", "course-file", "quiz"]
        : ["course-content", "sub-acquis", "module", "course-file", "video", "quiz"]
  );

  const byPreference = [...chunks].sort((a, b) => {
    const aRank = Array.from(preferredKinds).indexOf(a.kind);
    const bRank = Array.from(preferredKinds).indexOf(b.kind);
    return aRank - bRank;
  });

  const seen = new Set<string>();
  const refined: StudentRagChunk[] = [];

  for (const chunk of byPreference) {
    const key = chunk.subAcquisId
      ? `${chunk.moduleId}::${chunk.subAcquisId}`
      : `${chunk.moduleId}::module`;
    if (seen.has(key)) {
      continue;
    }

    // Unless explicitly asked, avoid listing many quiz chunks in final response context.
    if (!asksQuiz && chunk.kind === "quiz") {
      continue;
    }

    refined.push(chunk);
    seen.add(key);
    if (refined.length >= 5) {
      break;
    }
  }

  if (!refined.length) {
    return chunks.slice(0, 5);
  }

  return refined;
}

function hasMeaningfulGroundingInChunks(question: string, chunks: StudentRagChunk[]): boolean {
  if (!chunks.length) {
    return false;
  }

  const questionTokens = tokenizeForStudentRag(question);
  if (!questionTokens.length) {
    return false;
  }

  const uniqueQuestionTokens = new Set(questionTokens);
  let maxOverlap = 0;

  for (const chunk of chunks) {
    const chunkTokenSet = new Set(chunk.tokens);
    let overlap = 0;

    for (const token of uniqueQuestionTokens) {
      if (chunkTokenSet.has(token)) {
        overlap += 1;
      }
    }

    if (overlap > maxOverlap) {
      maxOverlap = overlap;
    }
  }

  const coverage = maxOverlap / Math.max(1, uniqueQuestionTokens.size);
  return maxOverlap >= 2 || coverage >= 0.35;
}

function isQuestionOutsideLangageC(question: string): boolean {
  const normalized = normalizeForLookup(question);
  const mentionsOtherLanguage =
    normalized.includes("python") ||
    normalized.includes("javascript") ||
    normalized.includes("java") ||
    normalized.includes("php") ||
    normalized.includes("ruby") ||
    normalized.includes("c++") ||
    normalized.includes("csharp") ||
    normalized.includes("c#");

  if (!mentionsOtherLanguage) {
    return false;
  }

  return !normalized.includes("langage c") && !normalized.includes(" en c") && !normalized.includes(" langage c ");
}

function isAmbiguousProgrammingQuestion(question: string): boolean {
  const normalized = normalizeForLookup(question);
  const asksCodingPattern =
    normalized.includes("boucle") ||
    normalized.includes("for") ||
    normalized.includes("while") ||
    normalized.includes("if") ||
    normalized.includes("fonction") ||
    normalized.includes("variable");

  if (!asksCodingPattern) {
    return false;
  }

  // If the learner asks a generic coding question without grounding to C or the module,
  // prefer a scoped refusal to avoid cross-language answers.
  const explicitlyScopedToC =
    normalized.includes("langage c") || normalized.includes(" en c") || normalized.includes("module");

  return !explicitlyScopedToC;
}

function buildStudentRagAnswer(question: string, topChunks: StudentRagChunk[]): string {
  const cleanQuestion = String(question || "").trim();
  if (!topChunks.length) {
    return "Je n'ai pas trouvé de contexte pertinent dans vos modules disponibles. Essayez avec un identifiant de module (ex: 4) ou de sous-acquis (ex: 4.3).";
  }

  const dedupSources = new Set<string>();
  const lines: string[] = [];
  for (const chunk of topChunks) {
    const source = chunk.subAcquisId
      ? `${chunk.moduleId}.${chunk.subAcquisId} - ${chunk.subAcquisName || "Sous-acquis"}`
      : `Module ${chunk.moduleId} - ${chunk.moduleName}`;

    if (!dedupSources.has(source)) {
      lines.push(`- ${source}`);
      dedupSources.add(source);
    }
  }

  const primary = topChunks[0];
  const primaryScope = primary.subAcquisName || primary.moduleName || "le contenu du module";
  const evidence = topChunks
    .slice(0, 3)
    .map((chunk) => {
      const label = chunk.subAcquisId
        ? `${chunk.moduleId}.${chunk.subAcquisId}`
        : `module ${chunk.moduleId}`;
      const excerpt = normalizeWhitespace(String(chunk.text || "")).slice(0, 240);
      return `- ${label}: ${excerpt}${excerpt.length >= 240 ? "..." : ""}`;
    })
    .filter(Boolean);

  return [
    `Pour répondre à votre question: ${cleanQuestion}`,
    `Point principal dans le module: ${primaryScope}.`,
    "Éléments trouvés dans le module:",
    ...evidence,
    "Si vous voulez, je peux détailler pas à pas à partir de ces éléments uniquement."
  ].join("\n");
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function isRefusalLikeAnswer(answer: string): boolean {
  const normalized = normalizeForLookup(answer);
  return (
    normalized.includes("je ne peux pas") ||
    normalized.includes("je ne peux pas fournir") ||
    normalized.includes("je ne peux pas vous aider") ||
    normalized.includes("je ne peux pas repondre") ||
    normalized.includes("pas fournir d'informations") ||
    normalized.includes("hors contexte")
  );
}

function isAnswerGroundedInChunks(answer: string, chunks: StudentRagChunk[]): boolean {
  const normalizedAnswer = normalizeForLookup(answer);
  if (!normalizedAnswer || !chunks.length) {
    return false;
  }

  let matches = 0;
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const candidates = [
      String(chunk.subAcquisName || "").trim(),
      String(chunk.moduleName || "").trim(),
      chunk.subAcquisId ? `${chunk.moduleId}.${chunk.subAcquisId}` : `module ${chunk.moduleId}`
    ]
      .map((entry) => normalizeForLookup(entry))
      .filter((entry) => entry.length >= 3);

    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }

      if (normalizedAnswer.includes(candidate)) {
        seen.add(candidate);
        matches += 1;
      }
    }

    if (matches >= 1) {
      return true;
    }
  }

  return false;
}

async function generateStudentChatAnswer(question: string, topChunks: StudentRagChunk[]): Promise<string | null> {
  if (!env.openaiApiKey && !env.geminiApiKey) {
    return null;
  }

  if (!topChunks.length) {
    return null;
  }

  const context = topChunks
    .slice(0, 6)
    .map((chunk, index) => {
      const label = chunk.subAcquisId
        ? `${chunk.moduleId}.${chunk.subAcquisId} - ${chunk.subAcquisName || "Sous-acquis"}`
        : `Module ${chunk.moduleId} - ${chunk.moduleName}`;
      return `${index + 1}. [${label}] (${chunk.kind}) ${chunk.text}`;
    })
    .join("\n");

  const systemPrompt =
    "Tu es l'assistant pédagogique NextLearn. Réponds en français, de manière claire et concise. Utilise EXCLUSIVEMENT le contenu du module présent dans le contexte récupéré. N'utilise aucune connaissance externe, aucun exemple inventé et aucune information non visible dans le contexte. Si la question concerne le module affiché, même formulée de façon générale, réponds à partir du contexte du module. Si l'information manque dans le module, dis clairement que ce n'est pas présent dans le contenu fourni et propose de consulter les ressources du module. Ne refuse que si la question parle clairement d'un autre langage ou d'un sujet hors contexte.";
  const userPrompt = [
    `Question étudiant: ${question}`,
    "Contexte récupéré:",
    context,
    "Consigne: réponds directement à la question en t'appuyant UNIQUEMENT sur le contexte du module, même si la formulation de l'étudiant est simple ou générale. Interdiction d'ajouter des informations externes. CITE explicitement au moins un élément du contexte (nom de sous-acquis, module.x.y ou extrait).",
    "Termine par une section 'Sources:' avec 1 à 3 éléments au format '- module.sous-acquis - titre'."
  ].join("\n\n");

  if (env.geminiApiKey) {
    const chatModelName = await resolveGeminiModelForMethod(
      "generateContent",
      env.geminiChatModel,
      ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-pro"]
    );

    const response = await fetch(
      `${env.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(chatModelName)}:generateContent?key=${encodeURIComponent(env.geminiApiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userPrompt }]
            }
          ],
          generationConfig: {
            temperature: 0.2
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Gemini chat request failed (${response.status}): ${errorText}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const content = extractAssistantText(payload.candidates?.[0]?.content?.parts);
    if (content) {
      return content;
    }
  }

  if (!env.openaiApiKey) {
    return null;
  }

  const response = await fetch(`${env.openaiChatBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.openaiChatModel,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Chat completion failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };

  const content = extractAssistantText(payload.choices?.[0]?.message?.content);
  return content || null;
}

webRouter.post("/api/student/chatbot", async (req, res) => {
  try {
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
    const rawMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";

    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }

    if (!rawMessage) {
      return res.status(400).json({ message: "Question requise" });
    }

    const [overview, persistedModules, access] = await Promise.all([
      readPersistedProgramCOverview(),
      readPersistedCurriculumModules(),
      readClassAccessByStudentIdentifier(identifier)
    ]);

    const accessibleOverview = filterOverviewByAccess(overview, access);
    if (!accessibleOverview.length) {
      return res.status(200).json({
        answer:
          "Je ne trouve aucun module disponible pour votre compte actuellement. Vérifiez votre calendrier ou contactez votre enseignant."
      });
    }

    const filterToModuleId = typeof req.body?.filterToModuleId === "string" ? req.body.filterToModuleId.trim() : undefined;
    const filterToSubAcquisId = typeof req.body?.filterToSubAcquisId === "string" ? req.body.filterToSubAcquisId.trim() : undefined;

    let embeddingScopeCheck: {
      usedEmbeddings: boolean;
      accepted: boolean;
      targetScore: number;
      topModuleId: string | null;
      topScore: number;
    } | null = null;

    if (filterToModuleId) {
      embeddingScopeCheck = await evaluateQuestionAgainstScopedModule({
        persistedModules,
        accessibleOverview,
        question: rawMessage,
        targetModuleId: filterToModuleId
      });
    }

    const rankedChunks = await getStudentVectorMatches({
      persistedModules,
      accessibleOverview,
      question: rawMessage,
      filterToModuleId,
      filterToSubAcquisId
    });

    const refinedChunks = refineStudentRagChunks(rawMessage, rankedChunks);

    // Refuse when question is about another language.
    if ((filterToModuleId || filterToSubAcquisId) && isQuestionOutsideLangageC(rawMessage)) {
      return res.status(200).json({
        answer:
          "Je peux vous aider uniquement sur le module en cours et en langage C. Reformulez votre question sans mentionner un autre langage.",
        mode: "scope-guard",
        retrieved: 0,
        sources: [],
        embeddingScope: embeddingScopeCheck ? {
          targetModuleId: filterToModuleId || null,
          targetScore: Number(embeddingScopeCheck.targetScore.toFixed(4)),
          topModuleId: embeddingScopeCheck.topModuleId,
          topScore: Number(embeddingScopeCheck.topScore.toFixed(4))
        } : undefined
      });
    }

    let answer = buildStudentRagAnswer(rawMessage, refinedChunks);
    let responseMode = hasEmbeddingProvider() ? "vector" : "rag";

    try {
      const generated = await generateStudentChatAnswer(rawMessage, refinedChunks);
      if (generated && !isRefusalLikeAnswer(generated) && isAnswerGroundedInChunks(generated, refinedChunks)) {
        answer = generated;
        responseMode = `${responseMode}+llm`;
      }
    } catch (error) {
      console.warn("Chat generation failed; using deterministic fallback:", error);
    }

    const sources = refinedChunks.map((chunk) => ({
      moduleId: chunk.moduleId,
      moduleName: chunk.moduleName,
      subAcquisId: chunk.subAcquisId,
      subAcquisName: chunk.subAcquisName,
      kind: chunk.kind,
      excerpt: normalizeWhitespace(String(chunk.text || "")).slice(0, 300)
    }));

    return res.status(200).json({
      answer,
      mode: responseMode,
      retrieved: sources.length,
      sources
    });
  } catch (error) {
    console.error("Failed to answer student chatbot question:", error);
    return res.status(500).json({ message: "Impossible de générer une réponse pour le moment" });
  }
});

function sanitizeQuestionOption(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function validateGeneratedQuestionCandidate(
  candidate: unknown,
  original: QuizQuestion
): QuizQuestion | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const candidateObject = candidate as {
    prompt?: unknown;
    options?: unknown;
    correctOptionIndex?: unknown;
  };
  const promptValue = sanitizeQuestionOption(String(candidateObject.prompt || ""));
  const rawOptions = candidateObject.options;
  const optionsValue = Array.isArray(rawOptions)
    ? rawOptions.map((entry) => sanitizeQuestionOption(String(entry || "")))
    : [];
  const correctValue = Number((candidate as { correctOptionIndex?: unknown }).correctOptionIndex);

  if (!promptValue) {
    return null;
  }

  if (!Number.isInteger(correctValue)) {
    return null;
  }

  const expectedOptionCount = Math.max(2, Array.isArray(original.options) ? original.options.length : 4);
  if (optionsValue.length !== expectedOptionCount) {
    return null;
  }

  if (correctValue < 0 || correctValue >= optionsValue.length) {
    return null;
  }

  const uniqueOptions = new Set(optionsValue.map((entry) => normalizeForLookup(entry)));
  if (uniqueOptions.size !== optionsValue.length || optionsValue.some((entry) => !entry)) {
    return null;
  }

  return {
    prompt: promptValue,
    options: optionsValue,
    correctOptionIndex: correctValue
  };
}

function buildFallbackQuestionVariation(
  question: QuizQuestion,
  wrongSelectedIndex: number,
  variationIndex: number,
  subAcquisName: string
): QuizQuestion {
  const options = [...question.options];
  if (options.length < 2 || question.correctOptionIndex === null) {
    return {
      prompt: `${deriveRemediationStem(question, subAcquisName)} (version ${variationIndex + 1})`,
      options,
      correctOptionIndex: question.correctOptionIndex
    };
  }

  const shift = (variationIndex % (options.length - 1)) + 1;
  const rotated = options.map((_, index) => options[(index + shift) % options.length]);
  const rotatedCorrect = (question.correctOptionIndex - shift + options.length) % options.length;

  let promptPrefix = "Version de rattrapage";
  if (Number.isInteger(wrongSelectedIndex) && wrongSelectedIndex >= 0 && wrongSelectedIndex < options.length) {
    promptPrefix = "Version ciblée";
  }

  return {
    prompt: `${promptPrefix}: ${deriveRemediationStem(question, subAcquisName)}`,
    options: rotated,
    correctOptionIndex: rotatedCorrect
  };
}

function deriveRemediationStem(question: QuizQuestion, subAcquisName: string): string {
  const rawPrompt = normalizeForLookup(String(question.prompt || ""));
  const cleanedPrompt = rawPrompt
    .replace(/^(quelle|quel|quelles|quels|comment|pourquoi|ou|où|quand|est ce que|est-ce que)\b[\s:,-]*/i, "")
    .trim();

  if (!cleanedPrompt) {
    return `Dans ${subAcquisName}, quelle proposition correspond le mieux au concept demandé ?`;
  }

  return `Dans ${subAcquisName}, quelle proposition correspond le mieux à: ${cleanedPrompt}`;
}

type RemediationGenerationTrace = {
  provider: "gemini" | "openai" | "fallback";
  model: string | null;
  systemPrompt: string;
  userPrompt: string;
  sourcePayload: Record<string, unknown>;
  generationConfig: Record<string, unknown>;
  rawResponseText: string | null;
};

type RemediationQuestionGeneration = {
  sourceQuestionIndex: number;
  originalQuestion: QuizQuestion;
  question: QuizQuestion;
  usedFallback: boolean;
  trace: RemediationGenerationTrace;
};

type RemediationQuizBuildResult = {
  questions: Array<{
    sourceQuestionIndex: number;
    prompt: string;
    options: string[];
    correctOptionIndex: number;
  }>;
  generations: RemediationQuestionGeneration[];
};

async function generateQuestionVariationWithAi(params: {
  moduleId: string;
  moduleName: string;
  subAcquisId: string;
  subAcquisName: string;
  sourceQuestionIndex: number;
  question: QuizQuestion;
  wrongSelectedIndex: number;
  supportFiles: {
    pptFiles: string[];
    videoFiles: string[];
  };
}): Promise<RemediationQuestionGeneration | null> {
  const { moduleId, moduleName, subAcquisId, subAcquisName, sourceQuestionIndex, question, wrongSelectedIndex, supportFiles } = params;

  const optionCount = Array.isArray(question.options) ? question.options.length : 4;
  const sourcePayload = {
    moduleId,
    moduleName,
    subAcquisId,
    subAcquisName,
    questionIndex: sourceQuestionIndex,
    prompt: question.prompt,
    options: question.options,
    correctOptionIndex: question.correctOptionIndex,
    selectedWrongOptionIndex: wrongSelectedIndex,
    selectedWrongOptionText:
      wrongSelectedIndex >= 0 && wrongSelectedIndex < question.options.length
        ? question.options[wrongSelectedIndex]
        : null,
    supportFiles
  };

  const systemPrompt =
    "Tu es un assistant pédagogique. Génère UNE nouvelle question de quiz en français sur le même concept, avec une formulation différente et un niveau similaire. Retourne strictement un JSON valide sans texte autour.";
  const generationConfig = {
    temperature: 0.35,
    topP: 0.9
  };
  const userPrompt = [
    "Génère une variation pour cette question ratée.",
    `Contraintes: exactement ${optionCount} options, 1 seule bonne réponse, contenu sûr, niveau identique, et la nouvelle question doit être différente de la question source sans changer l'objectif pédagogique.`,
    "Réponse JSON attendue:",
    '{"prompt":"...","options":["..."],"correctOptionIndex":0}',
    "Question source:",
    JSON.stringify(sourcePayload)
  ].join("\n\n");

  console.info("[remediation-ai] prompt trace", JSON.stringify({
    moduleId,
    moduleName,
    subAcquisId,
    subAcquisName,
    sourceQuestionIndex,
    systemPrompt,
    userPrompt,
    sourcePayload,
    generationConfig,
    usingGemini: Boolean(env.geminiApiKey),
    usingOpenAi: Boolean(env.openaiApiKey)
  }, null, 2));

  const parseAiResult = (raw: string): QuizQuestion | null => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;

    try {
      return validateGeneratedQuestionCandidate(JSON.parse(trimmed), question);
    } catch (_error) {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return validateGeneratedQuestionCandidate(JSON.parse(trimmed.slice(start, end + 1)), question);
        } catch (_nestedError) {
          return null;
        }
      }
      return null;
    }
  };

  const fallbackQuestion = buildFallbackQuestionVariation(question, wrongSelectedIndex, 0, subAcquisName);
  const fallbackTrace: RemediationGenerationTrace = {
    provider: "fallback",
    model: null,
    systemPrompt,
    userPrompt,
    sourcePayload,
    generationConfig,
    rawResponseText: null
  };

  if (env.geminiApiKey) {
    try {
      const chatModelName = await resolveGeminiModelForMethod(
        "generateContent",
        env.geminiChatModel,
        ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-pro"]
      );

      const response = await fetch(
        `${env.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(chatModelName)}:generateContent?key=${encodeURIComponent(env.geminiApiKey)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }]
            },
            contents: [
              {
                role: "user",
                parts: [{ text: userPrompt }]
              }
            ],
            generationConfig
          })
        }
      );

      if (response.ok) {
        const payload = (await response.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{ text?: string }>;
            };
          }>;
        };

        const content = extractAssistantText(payload.candidates?.[0]?.content?.parts);
        const parsed = parseAiResult(content);
        if (parsed) {
          return {
            sourceQuestionIndex,
            originalQuestion: question,
            question: parsed,
            usedFallback: false,
            trace: {
              provider: "gemini",
              model: chatModelName,
              systemPrompt,
              userPrompt,
              sourcePayload,
              generationConfig,
              rawResponseText: content || null
            }
          };
        }
      }
    } catch (error) {
      console.warn("Gemini remediation generation failed; using fallback:", error);
    }
  }

  if (env.openaiApiKey) {
    try {
      const response = await fetch(`${env.openaiChatBaseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openaiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: env.openaiChatModel,
          temperature: 0.35,
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: userPrompt
            }
          ]
        })
      });

      if (response.ok) {
        const payload = (await response.json()) as {
          choices?: Array<{
            message?: {
              content?: unknown;
            };
          }>;
        };

        const content = extractAssistantText(payload.choices?.[0]?.message?.content);
        const parsed = parseAiResult(content);
        if (parsed) {
          return {
            sourceQuestionIndex,
            originalQuestion: question,
            question: parsed,
            usedFallback: false,
            trace: {
              provider: "openai",
              model: env.openaiChatModel,
              systemPrompt,
              userPrompt,
              sourcePayload,
              generationConfig,
              rawResponseText: content || null
            }
          };
        }
      }
    } catch (error) {
      console.warn("OpenAI remediation generation failed; using fallback:", error);
    }
  }

  return {
    sourceQuestionIndex,
    originalQuestion: question,
    question: fallbackQuestion,
    usedFallback: true,
    trace: fallbackTrace
  };
}

async function generateTeacherQuizQuestions(params: {
  moduleId: string;
  moduleName: string;
  subAcquisId: string;
  subAcquisName: string;
  topic?: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  count: number;
  courseContent?: string[];
}): Promise<TeacherGeneratedQuestion[]> {
  const { moduleId, moduleName, subAcquisId, subAcquisName, topic, difficulty, count, courseContent } = params;
  const effectiveTopic = topic?.trim() || subAcquisName || moduleName || `${moduleId} / ${subAcquisId}`;

  const questions: TeacherGeneratedQuestion[] = [];

  const systemPrompt = `Tu es un expert pédagogique. Génère exactement ${count} questions de quiz en français sur le sujet "${effectiveTopic}" avec niveau "${difficulty}".
Chaque question doit avoir exactement 4 options avec une seule bonne réponse. Retourne UNIQUEMENT un JSON valide sans texte autour.
Format attendu: {"questions":[{"prompt":"...","options":["...","...","...","..."],"correctOptionIndex":0},...]}}`;

  const contextLines = courseContent && courseContent.length > 0
    ? `\n\nContexte pédagogique:\n${courseContent.slice(0, 3).join("\n")}`
    : "";

  const userPrompt = [
    `Module: ${moduleName} (${moduleId})`,
    `Sous-acquis: ${subAcquisName} (${subAcquisId})`,
    `Thème: ${effectiveTopic}`,
    `Difficulté: ${difficulty}`,
    `Nombre de questions: ${count}`,
    contextLines,
    "\nGénère les questions au format JSON. Assure-toi que chaque question:",
    "- Est pertinente pour le thème",
    "- A un niveau approprié pour '${difficulty}'",
    "- A exactement 4 options claires et distinctes",
    "- A une seule bonne réponse"
  ].join("\n");

  const parseQuestionsResult = (raw: string): TeacherGeneratedQuestion[] => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed.questions)) return [];

      return parsed.questions
        .map((q: any) => ({
          prompt: String(q.prompt || "").trim(),
          options: Array.isArray(q.options)
            ? q.options.map((o: any) => String(o || "").trim()).filter((o: string) => o.length > 0)
            : [],
          correctOptionIndex: Number(q.correctOptionIndex)
        }))
        .filter(
          (q: any) =>
            q.prompt &&
            q.options.length === 4 &&
            Number.isInteger(q.correctOptionIndex) &&
            q.correctOptionIndex >= 0 &&
            q.correctOptionIndex < 4
        );
    } catch (_error) {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(trimmed.slice(start, end + 1));
          if (!Array.isArray(parsed.questions)) return [];

          return parsed.questions
            .map((q: any) => ({
              prompt: String(q.prompt || "").trim(),
              options: Array.isArray(q.options)
                ? q.options.map((o: any) => String(o || "").trim()).filter((o: string) => o.length > 0)
                : [],
              correctOptionIndex: Number(q.correctOptionIndex)
            }))
            .filter(
              (q: any) =>
                q.prompt &&
                q.options.length === 4 &&
                Number.isInteger(q.correctOptionIndex) &&
                q.correctOptionIndex >= 0 &&
                q.correctOptionIndex < 4
            );
        } catch (_nestedError) {
          return [];
        }
      }
      return [];
    }
  };

  try {
    if (env.geminiApiKey) {
      try {
        const chatModelName = await resolveGeminiModelForMethod(
          "generateContent",
          env.geminiChatModel,
          ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-pro"]
        );

        const response = await fetch(
          `${env.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(chatModelName)}:generateContent?key=${encodeURIComponent(env.geminiApiKey)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: systemPrompt }]
              },
              contents: [
                {
                  role: "user",
                  parts: [{ text: userPrompt }]
                }
              ],
              generationConfig: {
                temperature: 0.7,
                topP: 0.9
              }
            })
          }
        );

        if (response.ok) {
          const payload = (await response.json()) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string }>;
              };
            }>;
          };

          const content = extractAssistantText(payload.candidates?.[0]?.content?.parts);
          const parsed = parseQuestionsResult(content);
          if (parsed.length > 0) {
            return parsed.map((q) => ({ ...q, source: "ai" as const }));
          }
        }
      } catch (error) {
        console.warn("Gemini teacher quiz generation failed; trying OpenAI:", error);
      }
    }

    if (env.openaiApiKey) {
      try {
        const response = await fetch(`${env.openaiChatBaseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.openaiApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: env.openaiChatModel,
            temperature: 0.7,
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              {
                role: "user",
                content: userPrompt
              }
            ]
          })
        });

        if (response.ok) {
          const payload = (await response.json()) as {
            choices?: Array<{
              message?: {
                content?: unknown;
              };
            }>;
          };

          const content = extractAssistantText(payload.choices?.[0]?.message?.content);
          const parsed = parseQuestionsResult(content);
          if (parsed.length > 0) {
            return parsed.map((q) => ({ ...q, source: "ai" as const }));
          }
        }
      } catch (error) {
        console.warn("OpenAI teacher quiz generation failed; using fallback:", error);
      }
    }
  } catch (error) {
    console.warn("Teacher quiz generation error:", error);
  }

  // Fallback: generate simple template questions
  // If course content is available, create fallback questions from it
  if (Array.isArray(courseContent) && courseContent.length > 0) {
    const allSentences: string[] = courseContent
      .flatMap((c) => String(c || "").split(/(?<=[.!?])\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length > 20);

    const shuffle = <T,>(arr: T[]) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };

    for (let i = 0; i < count; i++) {
      const base = allSentences[i % Math.max(1, allSentences.length)] || `Énoncé correct sur ${topic}`;

      // Build distractors from other sentences or variations
      const pool = allSentences.filter((s) => s !== base);
      shuffle(pool);
      const distractors = pool.slice(0, 3).map((s) => {
        // Shorten distractor to a single clause if too long
        return s.length > 120 ? s.slice(0, 116).trim() + '...' : s;
      });

      // Ensure we have 3 distractors
      while (distractors.length < 3) {
        distractors.push(`Autre proposition liée à ${topic}`);
      }

      const options = shuffle([base, ...distractors]).slice(0, 4);
      const correctIndex = options.indexOf(base);

      questions.push({
        prompt: `Dans le contexte du module, laquelle des propositions suivantes est correcte ?\n${base.replace(/\s+/g, ' ').slice(0, 320)}`,
        options,
        correctOptionIndex: correctIndex >= 0 ? correctIndex : 0,
        source: "fallback"
      });
    }

    return questions.slice(0, count);
  }

  // Generic fallback when no content is available
  for (let i = 0; i < count; i++) {
    questions.push({
      prompt: `Question ${i + 1} sur "${topic}" - Quel énoncé est correct ?`,
      options: [
        "Option A - Répondre avec le contenu du cours",
        "Option B - Répondre avec le contenu du cours",
        "Option C - Répondre avec le contenu du cours (correcte)",
        "Option D - Répondre avec le contenu du cours"
      ],
      correctOptionIndex: 2,
      source: "fallback"
    });
  }

  return questions.slice(0, count);
}

async function buildRemediationQuestions(params: {
  moduleId: string;
  moduleName: string;
  subAcquisId: string;
  subAcquisName: string;
  questions: QuizQuestion[];
  wrongQuestionIndexes: number[];
  answers: number[];
  supportFiles: {
    pptFiles: string[];
    videoFiles: string[];
  };
}): Promise<RemediationQuizBuildResult> {
  const { moduleId, moduleName, subAcquisId, subAcquisName, questions, wrongQuestionIndexes, answers, supportFiles } = params;
  const remediationQuestions: Array<{
    sourceQuestionIndex: number;
    prompt: string;
    options: string[];
    correctOptionIndex: number;
  }> = [];
  const questionGenerations: RemediationQuestionGeneration[] = [];

  for (let index = 0; index < wrongQuestionIndexes.length; index += 1) {
    const sourceQuestionIndex = wrongQuestionIndexes[index];
    const sourceQuestion = questions[sourceQuestionIndex];

    if (!sourceQuestion || sourceQuestion.correctOptionIndex === null) {
      continue;
    }

    const wrongSelectedIndex = Number(answers[sourceQuestionIndex]);
    const generated = await generateQuestionVariationWithAi({
      moduleId,
      moduleName,
      subAcquisId,
      subAcquisName,
      sourceQuestionIndex,
      question: sourceQuestion,
      wrongSelectedIndex,
      supportFiles
    });

    if (!generated) {
      continue;
    }

    const finalQuestion = generated.question;
    questionGenerations.push(generated);

    remediationQuestions.push({
      sourceQuestionIndex,
      prompt: finalQuestion.prompt,
      options: finalQuestion.options,
      correctOptionIndex:
        typeof finalQuestion.correctOptionIndex === "number" ? finalQuestion.correctOptionIndex : 0
    });
  }

  return {
    questions: remediationQuestions,
    generations: questionGenerations
  };
}

// Quiz submission endpoint.
// Receives user answers and computes score from DOCX answer key.
webRouter.post("/api/programmation-c/sub-acquis/:moduleId/:subAcquisId/submit", async (req, res) => {
  try {
    const { moduleId, subAcquisId } = req.params;
    const rawAnswers: unknown[] = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const answers = rawAnswers.map((entry) => Number(entry));
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";

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

    const correct = resources.quizQuestions.reduce((sum, question, index) => {
      if (question.correctOptionIndex === null) return sum;

      const selected = Number(answers[index]);
      const correctIndex = question.correctOptionIndex;
      const selectedOption = Number.isFinite(selected) ? question.options[selected] : null;
      const correctOption = correctIndex !== null ? question.options[correctIndex] : null;
      const isCorrectByIndex = selected === correctIndex;
      const isCorrectByText =
        !isCorrectByIndex &&
        selectedOption !== null &&
        correctOption !== null &&
        normalizeOptionText(selectedOption) === normalizeOptionText(correctOption);

      return isCorrectByIndex || isCorrectByText ? sum + 1 : sum;
    }, 0);

    const wrongQuestionIndexes = resources.quizQuestions
      .map((question, index) => {
        if (question.correctOptionIndex === null) {
          return -1;
        }

        const selected = Number(answers[index]);
        const correctIndex = question.correctOptionIndex;
        const selectedOption = Number.isFinite(selected) ? question.options[selected] : null;
        const correctOption = correctIndex !== null ? question.options[correctIndex] : null;
        const isCorrectByIndex = selected === correctIndex;
        const isCorrectByText =
          !isCorrectByIndex &&
          selectedOption !== null &&
          correctOption !== null &&
          normalizeOptionText(selectedOption) === normalizeOptionText(correctOption);

        return isCorrectByIndex || isCorrectByText ? -1 : index;
      })
      .filter((index) => index >= 0);

    const score = gradable > 0 ? Math.round((correct / gradable) * 100) : 0;
    const passed = gradable === 0 ? true : correct === gradable;

    if (identifier) {
      const lessonKey = buildLessonKey(moduleId, subAcquisId);

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
              submittedAt: new Date()
            }
          }
        }
      );
    }

    const review = resources.quizQuestions.map((question, index) => {
      const selected = Number(answers[index]);
      const correctIndex = typeof question.correctOptionIndex === "number" ? question.correctOptionIndex : null;
      const selectedOption = Number.isFinite(selected) ? question.options[selected] : null;
      const correctOption = correctIndex !== null ? question.options[correctIndex] : null;
      const isCorrectByIndex = selected === correctIndex;
      const isCorrectByText =
        !isCorrectByIndex &&
        selectedOption !== null &&
        correctOption !== null &&
        normalizeOptionText(selectedOption) === normalizeOptionText(correctOption);

      return {
        selectedIndex: Number.isFinite(selected) ? selected : -1,
        correctOptionIndex: isCorrectByText ? selected : correctIndex
      };
    });

    res.status(200).json({
      total,
      gradable,
      correct,
      score,
      passed,
      wrongQuestionCount: wrongQuestionIndexes.length,
      wrongQuestionIndexes,
      review
    });
  } catch (error) {
    console.error("Failed to score quiz:", error);
    res.status(400).json({ message: "Impossible de corriger le quiz" });
  }
});

webRouter.post("/api/student/progress/lesson-view", async (req, res) => {
  try {
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
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

/**
 * Derive ML prediction features from a user's raw progress data and profile.
 */
function extractMLFeatures(params: {
  progress?: {
    completedLessonKeys?: unknown[];
    quizResults?: Array<{ score?: unknown; submittedAt?: unknown }>;
    selfEvaluationResults?: Array<{ score?: unknown }>;
  };
  profile?: {
    loginCount?: number;
    lastLoginDate?: Date | null;
    createdAt?: Date;
  } | null;
  totalSubAcquis?: number;
}): Parameters<typeof MLPredictorService.predict>[0] {
  const { progress, profile, totalSubAcquis = 20 } = params;

  // completionPace: sub-acquis completed per week since account creation
  const completedCount = Array.isArray(progress?.completedLessonKeys)
    ? progress.completedLessonKeys.length
    : 0;

  const createdAt = profile?.createdAt ? new Date(profile.createdAt) : new Date();
  const weeksSinceCreation = Math.max(
    1,
    (Date.now() - createdAt.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  const completionPace = Math.min(5, completedCount / weeksSinceCreation);

  // delayWeeks: if the student is behind – gap between expected and actual completion
  // We use weeks since creation minus what they've actually done as a proxy.
  const expectedPace = 2; // 2 sub-acquis per week is "on track"
  const expectedCompleted = weeksSinceCreation * expectedPace;
  const delayWeeks = Math.min(12, Math.max(0, (expectedCompleted - completedCount) / expectedPace));

  // averageScore: mean quiz score
  const quizResults = Array.isArray(progress?.quizResults) ? progress.quizResults : [];
  const scores = quizResults.map((r) => Number(r?.score || 0)).filter((s) => Number.isFinite(s) && s > 0);
  const averageScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 50;

  // loginFrequency: logins per week
  const loginCount = Number(profile?.loginCount || 0);
  const loginFrequency = Math.min(14, loginCount / weeksSinceCreation);

  // gapDepth: fraction of curriculum not yet started
  const gapDepth = Math.max(0, Math.min(1, 1 - completedCount / Math.max(1, totalSubAcquis)));

  return {
    delayWeeks,
    completionPace,
    averageScore,
    loginFrequency,
    gapDepth
  };
}

webRouter.get("/api/student/prediction/:identifier", async (req, res) => {
  try {
    const identifier = String(req.params.identifier || "").trim();
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }

    const [user, profile] = await Promise.all([
      User.findOne({ identifier }).select({ identifier: 1, progress: 1 }).lean(),
      StudentProfile.findOne({ identifier }).select({ loginCount: 1, lastLoginDate: 1, createdAt: 1 }).lean()
    ]);

    if (!user) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const features = extractMLFeatures({
      progress: (user as any).progress,
      profile: profile as any
    });

    const catchupProbability = MLPredictorService.predict(features);

    res.status(200).json({
      identifier,
      catchupProbability,
      features
    });
  } catch (error) {
    console.error("Failed to compute prediction:", error);
    res.status(500).json({ message: "Impossible de calculer la prédiction" });
  }
});

webRouter.get("/api/backoffice/organization", async (_req, res) => {
  try {
    const [teachers, classes, students] = await Promise.all([
      Teacher.find().sort({ name: 1 }).lean(),
      ClassRoom.find().sort({ name: 1 }).lean(),
      StudentProfile.find().sort({ fullName: 1 }).lean()
    ]);

    const identifiers = students
      .map((student) => String(student.identifier || "").trim())
      .filter(Boolean);

    const users = identifiers.length
      ? await User.find({ identifier: { $in: identifiers } })
          .select({ identifier: 1, progress: 1 })
          .lean()
      : [];

    const profiles = identifiers.length
      ? await StudentProfile.find({ identifier: { $in: identifiers } })
          .select({ identifier: 1, loginCount: 1, lastLoginDate: 1, createdAt: 1 })
          .lean()
      : [];

    const userByIdentifier = new Map(
      users.map((user) => [String((user as any).identifier || "").trim(), user])
    );

    const profileByIdentifier = new Map(
      profiles.map((p) => [String((p as any).identifier || "").trim(), p])
    );

    res.status(200).json({
      teachers: teachers.map((teacher) => ({
        id: String(teacher._id),
        role: teacher.role || "enseignant",
        name: teacher.name,
        email: teacher.email || "",
        phone: teacher.phone || ""
      })),
      classes: classes.map((room) => ({
        id: String(room._id),
        name: room.name,
        teacherId: room.teacherId ? String(room.teacherId) : "",
        teacherName: room.teacherName || "Enseignant non assigne",
        accessByModule: toAccessRecord((room as any).accessByModule),
        scheduleStartDate: toIsoDateOrNull(room.scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord((room as any).accessScheduleBySubAcquis)
      })),
      students: students.map((student) => {
        const identifier = String(student.identifier || "").trim();
        const user = identifier ? userByIdentifier.get(identifier) : null;
        const prof = identifier ? profileByIdentifier.get(identifier) : null;
        const stats = user ? computeStudentProgress((user as any).progress) : null;

        const features = extractMLFeatures({
          progress: (user as any)?.progress,
          profile: prof as any
        });
        const catchupProbability = MLPredictorService.predict(features);

        return {
          id: String(student._id),
          fullName: student.fullName,
          identifier,
          email: student.email || "",
          classId: student.classId ? String(student.classId) : "",
          lessonsCompleted: stats?.lessonsCompleted ?? Number(student.lessonsCompleted || 0),
          quizzesTaken: stats?.quizzesPassed ?? Number(student.quizzesTaken || 0),
          averageQuizGrade: stats?.averageQuizScoreOn20 ?? Number(student.averageQuizGrade || 0),
          catchupProbability
        };
      })
    });
  } catch (error) {
    console.error("Failed to load backoffice organization:", error);
    res.status(500).json({ message: "Impossible de charger l'organisation" });
  }
});

webRouter.post("/api/backoffice/teachers", async (req, res) => {
  try {
    const name = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ message: "Nom complet, email, telephone et mot de passe sont requis" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Le mot de passe doit contenir au moins 6 caracteres" });
    }

    const existing = await Teacher.findOne({
      $or: [{ email }, { phone }]
    })
      .select({ _id: 1 })
      .lean();

    if (existing) {
      return res.status(409).json({ message: "Cet enseignant existe deja (email ou telephone)" });
    }

    const teacher = await Teacher.create({ name, email, phone, password });
    res.status(201).json({
      teacher: {
        id: String(teacher._id),
        role: teacher.role || "enseignant",
        name: teacher.name,
        email: teacher.email,
        phone: teacher.phone
      }
    });
  } catch (error) {
    console.error("Failed to create teacher:", error);
    res.status(500).json({ message: "Impossible d'ajouter l'enseignant" });
  }
});

webRouter.put("/api/backoffice/teachers/:teacherId", async (req, res) => {
  try {
    const teacherId = typeof req.params?.teacherId === "string" ? req.params.teacherId.trim() : "";
    const name = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!mongoose.isValidObjectId(teacherId)) {
      return res.status(400).json({ message: "Identifiant enseignant invalide" });
    }

    if (!name || !email || !phone) {
      return res.status(400).json({ message: "Nom complet, email et telephone sont requis" });
    }

    if (password && password.length < 6) {
      return res.status(400).json({ message: "Le mot de passe doit contenir au moins 6 caracteres" });
    }

    const teacher = await Teacher.findById(teacherId);
    if (!teacher) {
      return res.status(404).json({ message: "Enseignant introuvable" });
    }

    const duplicate = await Teacher.findOne({
      _id: { $ne: teacher._id },
      $or: [{ email }, { phone }]
    })
      .select({ _id: 1 })
      .lean();

    if (duplicate) {
      return res.status(409).json({ message: "Cet enseignant existe deja (email ou telephone)" });
    }

    teacher.name = name;
    teacher.email = email;
    teacher.phone = phone;
    if (password) {
      teacher.password = await hashPassword(password);
    }

    await teacher.save();

    await ClassRoom.updateMany(
      { teacherId: teacher._id },
      { $set: { teacherName: teacher.name } }
    );

    res.status(200).json({
      teacher: {
        id: String(teacher._id),
        role: teacher.role || "enseignant",
        name: teacher.name,
        email: teacher.email,
        phone: teacher.phone
      }
    });
  } catch (error) {
    console.error("Failed to update teacher:", error);
    res.status(500).json({ message: "Impossible de modifier l'enseignant" });
  }
});

webRouter.delete("/api/backoffice/teachers/:teacherId", async (req, res) => {
  try {
    const teacherId = typeof req.params?.teacherId === "string" ? req.params.teacherId.trim() : "";

    if (!mongoose.isValidObjectId(teacherId)) {
      return res.status(400).json({ message: "Identifiant enseignant invalide" });
    }

    const teacher = await Teacher.findById(teacherId).select({ _id: 1 }).lean();
    if (!teacher) {
      return res.status(404).json({ message: "Enseignant introuvable" });
    }

    const assignedClass = await ClassRoom.findOne({ teacherId: teacher._id })
      .select({ _id: 1 })
      .lean();

    if (assignedClass) {
      return res.status(409).json({
        message: "Impossible de supprimer cet enseignant: il est encore assigne a une classe"
      });
    }

    await Teacher.deleteOne({ _id: teacher._id });
    res.status(200).json({ message: "Enseignant supprime" });
  } catch (error) {
    console.error("Failed to delete teacher:", error);
    res.status(500).json({ message: "Impossible de supprimer l'enseignant" });
  }
});

webRouter.post("/api/backoffice/classes", async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const teacherId = typeof req.body?.teacherId === "string" ? req.body.teacherId.trim() : "";

    if (!name || !teacherId) {
      return res.status(400).json({ message: "Nom de classe et enseignant sont requis" });
    }

    const teacher = await Teacher.findById(teacherId).lean();
    if (!teacher) {
      return res.status(404).json({ message: "Enseignant introuvable" });
    }

    const duplicate = await ClassRoom.findOne({ name: new RegExp(`^${name}$`, "i") })
      .select({ _id: 1 })
      .lean();
    if (duplicate) {
      return res.status(409).json({ message: "Cette classe existe deja" });
    }

    const classRoom = await ClassRoom.create({
      name,
      teacherId: teacher._id,
      teacherName: teacher.name,
      accessByModule: {},
      scheduleStartDate: null,
      accessScheduleBySubAcquis: {}
    });

    res.status(201).json({
      classRoom: {
        id: String(classRoom._id),
        name: classRoom.name,
        teacherId: String(classRoom.teacherId),
        teacherName: classRoom.teacherName,
        accessByModule: toAccessRecord(classRoom.accessByModule),
        scheduleStartDate: toIsoDateOrNull(classRoom.scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord(classRoom.accessScheduleBySubAcquis)
      }
    });
  } catch (error) {
    console.error("Failed to create class:", error);
    res.status(500).json({ message: "Impossible d'ajouter la classe" });
  }
});

webRouter.post("/api/backoffice/students", async (req, res) => {
  try {
    const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const classId = typeof req.body?.classId === "string" ? req.body.classId.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!fullName || !identifier || !password || !classId || !email) {
      return res.status(400).json({ message: "Nom, email, identifiant, mot de passe et classe sont requis" });
    }

    if (identifier.length < 3) {
      return res.status(400).json({ message: "L'identifiant doit contenir au moins 3 caracteres" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Le mot de passe doit contenir au moins 6 caracteres" });
    }

    const classRoom = await ClassRoom.findById(classId).lean();
    if (!classRoom) {
      return res.status(404).json({ message: "Classe introuvable" });
    }

    const [existingProfile, existingUser] = await Promise.all([
      StudentProfile.findOne({ $or: [{ identifier }, { email }] }).select({ _id: 1 }).lean(),
      User.findOne({ $or: [{ identifier }, { email }] }).select({ _id: 1 }).lean()
    ]);

    if (existingProfile || existingUser) {
      return res.status(409).json({ message: "Cet identifiant ou email etudiant existe deja" });
    }

    const user = await User.create({ fullName, identifier, email, password });

    let student;
    try {
      student = await StudentProfile.create({
        fullName,
        identifier,
        email,
        classId: classRoom._id,
        lessonsCompleted: 0,
        quizzesTaken: 0,
        averageQuizGrade: 0
      });
    } catch (profileError) {
      await User.deleteOne({ _id: user._id }).catch(() => undefined);
      throw profileError;
    }

    res.status(201).json({
      student: {
        id: String(student._id),
        fullName: student.fullName,
        identifier: student.identifier,
        email: student.email || "",
        classId: String(student.classId),
        lessonsCompleted: Number(student.lessonsCompleted || 0),
        quizzesTaken: Number(student.quizzesTaken || 0),
        averageQuizGrade: Number(student.averageQuizGrade || 0)
      }
    });
  } catch (error) {
    console.error("Failed to create student:", error);
    res.status(500).json({ message: "Impossible d'ajouter l'etudiant" });
  }
});

webRouter.put("/api/backoffice/students/:studentId", async (req, res) => {
  try {
    const studentId = String(req.params.studentId || "").trim();
    const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const classId = typeof req.body?.classId === "string" ? req.body.classId.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!mongoose.isValidObjectId(studentId)) {
      return res.status(400).json({ message: "Identifiant etudiant invalide" });
    }

    if (!fullName || !identifier || !classId || !email) {
      return res.status(400).json({ message: "Nom, email, identifiant et classe sont requis" });
    }

    if (identifier.length < 3) {
      return res.status(400).json({ message: "L'identifiant doit contenir au moins 3 caracteres" });
    }

    if (password && password.length < 6) {
      return res.status(400).json({ message: "Le mot de passe doit contenir au moins 6 caracteres" });
    }

    const classRoom = await ClassRoom.findById(classId).lean();
    if (!classRoom) {
      return res.status(404).json({ message: "Classe introuvable" });
    }

    const student = await StudentProfile.findById(studentId);
    if (!student) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const linkedUser = await User.findOne({
      $or: [{ identifier: student.identifier }, { email: student.email || "" }]
    });

    const [existingProfile, existingUser] = await Promise.all([
      StudentProfile.findOne({
        _id: { $ne: student._id },
        $or: [{ identifier }, { email }]
      })
        .select({ _id: 1 })
        .lean(),
      User.findOne({
        _id: linkedUser?._id ? { $ne: linkedUser._id } : { $exists: true },
        $or: [{ identifier }, { email }]
      })
        .select({ _id: 1 })
        .lean()
    ]);

    if (existingProfile || existingUser) {
      return res.status(409).json({ message: "Cet identifiant ou email etudiant existe deja" });
    }

    student.fullName = fullName;
    student.identifier = identifier;
    student.email = email;
    student.classId = classRoom._id;
    await student.save();

    if (linkedUser) {
      linkedUser.fullName = fullName;
      linkedUser.identifier = identifier;
      linkedUser.email = email;
      if (password) {
        linkedUser.password = password;
      }
      await linkedUser.save();
    }

    res.status(200).json({
      student: {
        id: String(student._id),
        fullName: student.fullName,
        identifier: student.identifier,
        email: student.email || "",
        classId: String(student.classId),
        lessonsCompleted: Number(student.lessonsCompleted || 0),
        quizzesTaken: Number(student.quizzesTaken || 0),
        averageQuizGrade: Number(student.averageQuizGrade || 0)
      }
    });
  } catch (error) {
    console.error("Failed to update student:", error);
    res.status(500).json({ message: "Impossible de modifier l'etudiant" });
  }
});

webRouter.delete("/api/backoffice/students/:studentId", async (req, res) => {
  try {
    const studentId = String(req.params.studentId || "").trim();

    if (!mongoose.isValidObjectId(studentId)) {
      return res.status(400).json({ message: "Identifiant etudiant invalide" });
    }

    const student = await StudentProfile.findById(studentId).lean();
    if (!student) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    await StudentProfile.deleteOne({ _id: student._id });
    await User.deleteOne({
      $or: [{ identifier: student.identifier }, { email: student.email || "" }]
    });

    res.status(200).json({ message: "Etudiant supprime" });
  } catch (error) {
    console.error("Failed to delete student:", error);
    res.status(500).json({ message: "Impossible de supprimer l'etudiant" });
  }
});

webRouter.post("/api/backoffice/classes/:classId/access", async (req, res) => {
  try {
    const classId = String(req.params.classId || "").trim();
    const moduleId = typeof req.body?.moduleId === "string" ? req.body.moduleId.trim() : "";
    const accessRule = typeof req.body?.accessRule === "string" ? req.body.accessRule.trim() : "";

    if (!classId || !moduleId || !accessRule) {
      return res.status(400).json({ message: "classId, moduleId et accessRule sont requis" });
    }

    const classRoom = await ClassRoom.findById(classId);
    if (!classRoom) {
      return res.status(404).json({ message: "Classe introuvable" });
    }

    const access = classRoom.accessByModule || new Map<string, string>();
    access.set(moduleId, accessRule);
    classRoom.accessByModule = access;
    await classRoom.save();

    res.status(200).json({
      classRoom: {
        id: String(classRoom._id),
        name: classRoom.name,
        teacherId: String(classRoom.teacherId),
        teacherName: classRoom.teacherName,
        accessByModule: toAccessRecord(classRoom.accessByModule),
        scheduleStartDate: toIsoDateOrNull(classRoom.scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord(classRoom.accessScheduleBySubAcquis)
      }
    });
  } catch (error) {
    console.error("Failed to update class access:", error);
    res.status(500).json({ message: "Impossible de mettre a jour l'acces de la classe" });
  }
});

webRouter.post("/api/backoffice/classes/:classId/schedule", async (req, res) => {
  try {
    const classId = String(req.params.classId || "").trim();
    const startDateInput = typeof req.body?.startDate === "string" ? req.body.startDate.trim() : "";

    if (!classId || !startDateInput) {
      return res.status(400).json({ message: "classId et startDate sont requis" });
    }

    const classRoom = await ClassRoom.findById(classId);
    if (!classRoom) {
      return res.status(404).json({ message: "Classe introuvable" });
    }

    const parsedStartDate = parseStartDateInput(startDateInput);
    if (!parsedStartDate) {
      return res.status(400).json({ message: "Date de debut invalide" });
    }

    const [overview, weekMap] = await Promise.all([
      readPersistedProgramCOverview(),
      readCalendarWeekMapFromFile()
    ]);

    const scheduleBySubAcquis = buildScheduleBySubAcquis({
      overview,
      weekMap,
      startDate: parsedStartDate
    });

    classRoom.scheduleStartDate = parsedStartDate;
    classRoom.accessScheduleBySubAcquis = new Map<string, Date>(
      Object.entries(scheduleBySubAcquis).map(([subAcquisId, isoValue]) => [
        encodeScheduleStorageKey(subAcquisId),
        new Date(isoValue)
      ])
    );
    await classRoom.save();

    res.status(200).json({
      classRoom: {
        id: String(classRoom._id),
        name: classRoom.name,
        teacherId: String(classRoom.teacherId),
        teacherName: classRoom.teacherName,
        accessByModule: toAccessRecord(classRoom.accessByModule),
        scheduleStartDate: toIsoDateOrNull(classRoom.scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord(classRoom.accessScheduleBySubAcquis)
      },
      generatedCount: Object.keys(scheduleBySubAcquis).length
    });
  } catch (error) {
    console.error("Failed to generate class schedule:", error);
    res.status(500).json({ message: "Impossible de generer le calendrier de la classe" });
  }
});

webRouter.post("/api/backoffice/classes/schedule-all", async (req, res) => {
  try {
    const startDateInput = typeof req.body?.startDate === "string" ? req.body.startDate.trim() : "";
    if (!startDateInput) {
      return res.status(400).json({ message: "startDate est requis" });
    }

    const parsedStartDate = parseStartDateInput(startDateInput);
    if (!parsedStartDate) {
      return res.status(400).json({ message: "Date de debut invalide" });
    }

    const [overview, weekMap, classRooms] = await Promise.all([
      readPersistedProgramCOverview(),
      readCalendarWeekMapFromFile(),
      ClassRoom.find()
    ]);

    const scheduleBySubAcquis = buildScheduleBySubAcquis({
      overview,
      weekMap,
      startDate: parsedStartDate
    });

    for (const classRoom of classRooms) {
      classRoom.scheduleStartDate = parsedStartDate;
      classRoom.accessScheduleBySubAcquis = new Map<string, Date>(
        Object.entries(scheduleBySubAcquis).map(([subAcquisId, isoValue]) => [
          encodeScheduleStorageKey(subAcquisId),
          new Date(isoValue)
        ])
      );
      await classRoom.save();
    }

    const refreshedClasses = await ClassRoom.find().sort({ name: 1 }).lean();

    res.status(200).json({
      updatedClassCount: refreshedClasses.length,
      generatedCount: Object.keys(scheduleBySubAcquis).length,
      classes: refreshedClasses.map((room) => ({
        id: String(room._id),
        name: room.name,
        teacherId: room.teacherId ? String(room.teacherId) : "",
        teacherName: room.teacherName || "Enseignant non assigne",
        accessByModule: toAccessRecord((room as any).accessByModule),
        scheduleStartDate: toIsoDateOrNull((room as any).scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord((room as any).accessScheduleBySubAcquis)
      }))
    });
  } catch (error) {
    console.error("Failed to generate global class schedule:", error);
    res.status(500).json({ message: "Impossible de generer le calendrier global" });
  }
});

// Sign-in page endpoint.
// Uses dedicated auth file under public/auth for organized static page structure.
webRouter.get("/sign-in", (_req, res) => {
  const signInPath = path.join(process.cwd(), "public", "auth", "sign-in.html");
  res.sendFile(signInPath);
});

// Forgot-password page endpoint.
webRouter.get("/forgot-password", (_req, res) => {
  const forgotPasswordPath = path.join(process.cwd(), "public", "auth", "forgot-password.html");
  res.sendFile(forgotPasswordPath);
});

// Reset-password page endpoint.
webRouter.get("/reset-password", (_req, res) => {
  const resetPasswordPath = path.join(process.cwd(), "public", "auth", "reset-password.html");
  res.sendFile(resetPasswordPath);
});

// Public sign-up route is disabled. Keep this endpoint for backward compatibility.
webRouter.get("/sign-up", (_req, res) => {
  res.redirect("/sign-in");
});

// Backoffice page endpoint.
// Serves the admin and teacher interface for dashboards and content management.
webRouter.get("/backoffice", (_req, res) => {
  const backofficePath = path.join(process.cwd(), "public", "backoffice", "index.html");
  res.sendFile(backofficePath);
});

// Student dashboard endpoint.
// Blackboard-like student area with sidebar navigation and course access.
webRouter.get("/student", (_req, res) => {
  const studentDashboardPath = path.join(process.cwd(), "public", "student", "index.html");
  res.sendFile(studentDashboardPath);
});

// Student embedded C course endpoint.
// Serves a dedicated version without the main platform header.
webRouter.get("/student/programmation-c", (_req, res) => {
  const studentCoursePath = path.join(process.cwd(), "public", "student", "programmation-c.html");
  res.sendFile(studentCoursePath);
});

// ============================================
// TEACHER QUIZ GENERATION ENDPOINTS
// ============================================

// Endpoint: Generate quiz questions based on the selected module and sub-acquis
webRouter.post("/api/teacher/quizzes/generate", async (req, res) => {
  try {
    cleanExpiredSessions();

    const moduleId = typeof req.body?.moduleId === "string" ? req.body.moduleId.trim() : "";
    const subAcquisId = typeof req.body?.subAcquisId === "string" ? req.body.subAcquisId.trim() : "";
    const difficulty = req.body?.difficulty || "intermediate";
    const count = Math.min(Math.max(Number(req.body?.count) || 5, 1), 10);

    if (!moduleId || !subAcquisId) {
      return res.status(400).json({
        message: "moduleId et subAcquisId sont requis"
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

    const subAcquis = module.acquis
      .flatMap((a) => a.sousAcquis)
      .find((s) => s.id === subAcquisId);
    if (!subAcquis) {
      return res.status(404).json({ message: "Sous-acquis introuvable" });
    }
    const generationTopic = subAcquis.name || module.name || `${moduleId} / ${subAcquisId}`;

    // Extract course content for context
    let courseContent: string[] = [];
    try {
      if (Array.isArray(subAcquis.courseFiles) && subAcquis.courseFiles.length > 0) {
        const snippets = await extractCourseContentSnippetsFromUrl(subAcquis.courseFiles[0].url);
        courseContent = snippets.slice(0, 3);
      }
    } catch (error) {
      console.warn("Could not extract course content for generation context:", error);
    }

    // Generate questions
    const generatedQuestions = await generateTeacherQuizQuestions({
      moduleId,
      moduleName: module.name || moduleId,
      subAcquisId,
      subAcquisName: subAcquis.name || subAcquisId,
      topic: generationTopic,
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
      subAcquisId,
      subAcquisName: subAcquis.name || subAcquisId,
      topic: generationTopic,
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

// Teacher quiz generator page
webRouter.get("/teacher/quiz-generator", (_req, res) => {
  const quizGeneratorPath = path.join(process.cwd(), "public", "teacher", "quiz-generator.html");
  res.sendFile(quizGeneratorPath, (err: any) => {
    if (err) {
      res.status(404).send("Quiz generator page not found");
    }
  });
});

export { webRouter };
