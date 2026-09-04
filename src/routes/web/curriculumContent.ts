/**
 * routes/web/curriculumContent.ts
 *
 * How curriculum content (modules, sous-acquis, course files, videos, and
 * embedded quizzes) gets read from and written to MongoDB, the filesystem
 * seed under content/Support_Cours_Préparation, and GridFS. Quiz TEXT parsing
 * (DOCX / normalized JSON -> QuizQuestion[]) lives here rather than in a
 * separate "quiz" module because it is structurally part of the seeding
 * pipeline: a sous-acquis's quiz questions are parsed straight out of its
 * course-content folder when the seed is built.
 *
 * Split out of the former 1946-line shared.ts (see that file's header) —
 * this is one half of that split, grouped by "how curriculum content moves
 * between storage layers". The other half (assessmentState.ts) covers
 * recommendation-graph caching, the teacher quiz-generation session store,
 * remediation-quiz attempt state, and self-evaluation scoring — genuinely
 * different concerns that happened to live in the same file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mammoth from "mammoth";
import { CurriculumModule } from "../../models/CurriculumModule";
import {
  canonicalMediaKey,
  isLocalMediaUrl,
  mirrorPublicFileToGridFs
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
  CurriculumCourseFile,
  CurriculumModuleDoc,
  CurriculumQuizQuestion,
  CurriculumSubAcquis,
  CurriculumVideo,
  ModuleOverview,
  QuizJsonPayload,
  QuizQuestion
} from "../../types/curriculum";

export const publicRoot = path.join(process.cwd(), "public");
export const supportRoot = path.join(process.cwd(), "content", "Support_Cours_Préparation");
export const generatedQuizzesRoot = path.join(publicRoot, "generated-quizzes");
// Must match the ASCII mount path in server.ts (see the comment there for why
// it can't be the accented folder name).
export const supportPublicPrefix = "/support-cours/";
export const execFileAsync = promisify(execFile);

export type CurriculumNamesData = {
  modulesById: Record<string, string>;
  subAcquisById: Record<string, string>;
};

export function createStableId(prefix: string, value: string): string {
  return `${prefix}-${sanitizePathSegment(value).toLowerCase()}`;
}

export function buildCourseFileEntries(fileUrls: string[]): CurriculumCourseFile[] {
  return fileUrls.map((url, index) => ({
    id: createStableId(`course-${index + 1}`, url),
    title: path.basename(new URL(url, "http://localhost").pathname) || `Document ${index + 1}`,
    url,
    fileType: "pdf"
  }));
}

export function buildVideoEntries(videoUrls: string[]): CurriculumVideo[] {
  return videoUrls.map((url, index) => ({
    id: createStableId(`video-${index + 1}`, url),
    title: `Video ${index + 1}`,
    url,
    source: /^https?:\/\//i.test(url) ? "external" : "filesystem"
  }));
}

export function toCurriculumQuestion(question: QuizQuestion): CurriculumQuizQuestion {
  return {
    prompt: question.prompt,
    options: [...question.options],
    correctAnswerIndex: question.correctOptionIndex
  };
}

export function moduleDocToPublic(moduleDoc: CurriculumModuleDoc): CurriculumModuleDoc {
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

export function hasRenderableCurriculum(modules: CurriculumModuleDoc[]): boolean {
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

export function listSubAcquisIds(moduleDoc: CurriculumModuleDoc): string[] {
  return (Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : []).flatMap((acquis) =>
    Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis.map((entry) => String(entry.id || "").trim()).filter(Boolean) : []
  );
}

export function hasMissingFilesystemCurriculumEntries(
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

export function mergeMissingCurriculumEntries(
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

export function parseCurriculumNamesText(text: string): CurriculumNamesData {
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

export async function readCurriculumNamesFromFile(): Promise<CurriculumNamesData> {
  try {
    const namesFilePath = path.join(supportRoot, "modules+noms.txt");
    const raw = await fs.readFile(namesFilePath, "utf8");
    return parseCurriculumNamesText(raw);
  } catch (_error) {
    return { modulesById: {}, subAcquisById: {} };
  }
}

export function applyCurriculumNames(modules: CurriculumModuleDoc[], names: CurriculumNamesData): {
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

export function toPublicPath(absolutePath: string): string {
  const normalized = path.normalize(absolutePath);
  if (normalized.startsWith(`${supportRoot}${path.sep}`)) {
    const relative = path.relative(supportRoot, normalized);
    return `${supportPublicPrefix}${relative.split(path.sep).join("/")}`;
  }

  const relative = path.relative(publicRoot, normalized);
  return `/${relative.split(path.sep).join("/")}`;
}

export function sanitizePathSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "item";
}

export function buildSourceUploadPath(
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

export function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export async function convertPowerPointToPdf(inputPath: string, outputPath: string): Promise<void> {
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

export async function findFirstDirectoryByName(baseDir: string, acceptedNames: string[]): Promise<string | null> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const match = entries.find(
    (entry) => entry.isDirectory() && acceptedNames.includes(entry.name.toLowerCase())
  );

  return match ? path.join(baseDir, match.name) : null;
}

export function parseQuizDocxRawText(rawText: string): QuizQuestion[] {
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

export function parseNormalizedQuizJson(rawJson: string): QuizQuestion[] {
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

export async function subAcquisHasQuiz(subRoot: string): Promise<boolean> {
  const quizDirectory = await findFirstDirectoryByName(subRoot, ["quiz", "quizz"]);
  if (!quizDirectory) return false;

  const quizEntries = await fs.readdir(quizDirectory, { withFileTypes: true });
  return quizEntries.some((entry) => {
    if (!entry.isFile()) return false;
    const extension = path.extname(entry.name).toLowerCase();
    return extension === ".docx" || extension === ".json";
  });
}

export async function subAcquisHasVideo(subRoot: string): Promise<boolean> {
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

export function extractHttpLinksFromUnknownPayload(payload: unknown): string[] {
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

export async function readExternalVideoLinks(subRoot: string): Promise<string[]> {
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
    // Only an explicitly configured video-links.json may apply links globally.
    // The template file contains examples and must never be exposed to every
    // subskill as real student content.
    const globalCandidates = [path.join(supportRoot, "video-links.json")];

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

export async function readProgramCOverview(): Promise<ModuleOverview[]> {
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

export async function readSubAcquisResources(moduleId: string, subAcquisId: string): Promise<{
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

export async function buildCurriculumSeedFromFilesystem(): Promise<CurriculumModuleDoc[]> {
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

export async function ensureCurriculumSeeded(): Promise<void> {
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

export async function savePersistedCurriculumModules(modules: CurriculumModuleDoc[]): Promise<void> {
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

export async function readPersistedSubAcquisResources(moduleId: string, subAcquisId: string): Promise<{
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
          // Teacher-entered links are stored as `external`; keep valid HTTP(S)
          // URLs alongside videos mirrored into GridFS/media storage.
          const isExternalUrl = /^https?:\/\//i.test(url);
          return isExternalUrl || url.startsWith("/api/media/") || source === "db" || source === "gridfs";
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

// Curriculum size (shared by prediction routes and organization.ts).
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
