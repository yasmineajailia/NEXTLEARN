/**
 * media.routes.ts
 *
 * Course-file media streaming and teacher upload/convert.
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

export const mediaRouter = Router();

mediaRouter.get("/api/media/:fileId/:filename", async (req, res) => {
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
mediaRouter.post("/api/backoffice/upload-course-file", async (req, res) => {
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

