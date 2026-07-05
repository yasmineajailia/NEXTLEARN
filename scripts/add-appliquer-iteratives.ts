/**
 * Adds the three "Appliquer les structures itératives" loop lessons as new
 * sous-acquis (3.5, 3.6, 3.7) under acquis "acq-chap-3" of the "programmation-c"
 * module. Each lesson's PPTX is mirrored into the curriculum-media GridFS bucket
 * and its quiz is parsed from the sibling *.normalized.json file.
 *
 * Idempotent: sous-acquis that already exist (by id) are skipped.
 *
 * Source: content/Support_Cours_Préparation/3/Appliquer Structures itératives/
 */

import path from "path";
import { promises as fs } from "fs";
import { Readable } from "stream";
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { CurriculumModule } from "../src/models/CurriculumModule";

const SUPPORT_ROOT = path.join(process.cwd(), "content", "Support_Cours_Préparation");
const SOURCE_DIR = path.join(SUPPORT_ROOT, "3", "Appliquer Structures itératives");
const MODULE_ID = "programmation-c";
const ACQUIS_ID = "acq-chap-3";
const BUCKET_NAME = "curriculum-media";

// New sous-acquis to create, in curriculum order. `pptx`/`quiz` are basenames
// inside SOURCE_DIR.
const LESSONS = [
  { id: "3.5", name: "Appliquer la boucle for", pptx: "Boucle for.pptx", quiz: "Quizz_for.normalized.json" },
  { id: "3.6", name: "Appliquer la boucle while", pptx: "Boucle while.pptx", quiz: "Quizz_while.normalized.json" },
  { id: "3.7", name: "Appliquer la boucle do while", pptx: "Boucle do..while.pptx", quiz: "Quizz_do_while.normalized.json" }
];

function normalizeWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizePathSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "item";
}

function createStableId(prefix: string, value: string): string {
  return `${prefix}-${sanitizePathSegment(value).toLowerCase()}`;
}

function inferContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}

function buildMediaPublicUrl(fileId: string, filename: string): string {
  return `/api/media/${encodeURIComponent(fileId)}/${encodeURIComponent(filename)}`;
}

async function uploadToGridFs(buffer: Buffer, filename: string, metadata: Record<string, unknown>): Promise<string> {
  if (!mongoose.connection.db) throw new Error("MongoDB connection is not ready");
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
  const contentType = inferContentType(filename);
  const uploadStream = bucket.openUploadStream(filename, { metadata: { ...metadata, contentType } });
  await new Promise<void>((resolve, reject) => {
    uploadStream.on("finish", () => resolve());
    uploadStream.on("error", reject);
    Readable.from(buffer).pipe(uploadStream);
  });
  return buildMediaPublicUrl(uploadStream.id.toString(), filename);
}

// Mirrors parseNormalizedQuizJson + toCurriculumQuestion from web.ts.
function parseQuizJson(rawJson: string): Array<{ prompt: string; options: string[]; correctAnswerIndex: number | null }> {
  const parsed = JSON.parse(rawJson) as { questions?: Array<{ prompt?: unknown; options?: unknown; correctOptionIndex?: unknown }> };
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  return questions
    .map((q) => {
      const prompt = normalizeWhitespace(String(q?.prompt ?? ""));
      const options = Array.isArray(q?.options) ? q.options.map((o) => normalizeWhitespace(String(o))).filter(Boolean) : [];
      const raw = q?.correctOptionIndex;
      const idx = typeof raw === "number" && Number.isFinite(raw) ? Number(raw) : null;
      const bounded = idx !== null && idx >= 0 && idx < options.length ? idx : null;
      return { prompt, options, correctAnswerIndex: bounded };
    })
    .filter((q) => q.prompt.length > 0 && q.options.length >= 2);
}

async function main(): Promise<void> {
  if (!env.mongodbUri) throw new Error("MONGODB_URI environment variable is not set");
  await mongoose.connect(env.mongodbUri);

  const moduleDoc: any = await CurriculumModule.findOne({ id: MODULE_ID });
  if (!moduleDoc) throw new Error(`Module "${MODULE_ID}" not found`);

  const acquis = (moduleDoc.acquis || []).find((a: any) => a.id === ACQUIS_ID);
  if (!acquis) throw new Error(`Acquis "${ACQUIS_ID}" not found in module`);

  const existingIds = new Set((acquis.sousAcquis || []).map((s: any) => String(s.id)));
  let added = 0;

  for (const lesson of LESSONS) {
    if (existingIds.has(lesson.id)) {
      console.log(`Skipped (already exists): ${lesson.id} ${lesson.name}`);
      continue;
    }

    const pptxPath = path.join(SOURCE_DIR, lesson.pptx);
    const quizPath = path.join(SOURCE_DIR, lesson.quiz);

    const pptxBuffer = await fs.readFile(pptxPath);
    const mediaUrl = await uploadToGridFs(pptxBuffer, lesson.pptx, {
      moduleId: MODULE_ID,
      subAcquisId: lesson.id,
      kind: "course-file"
    });
    const fileTitle = path.basename(lesson.pptx, path.extname(lesson.pptx));

    const courseFiles = [
      { id: createStableId("course", mediaUrl), title: fileTitle, url: mediaUrl, fileType: inferContentType(lesson.pptx) }
    ];

    const questions = parseQuizJson(await fs.readFile(quizPath, "utf8"));
    const quizzes = questions.length
      ? [{ id: createStableId("quiz", lesson.id), type: "qcm", title: `Quiz ${lesson.id}`, questions }]
      : [];

    acquis.sousAcquis.push({
      id: lesson.id,
      name: lesson.name,
      bloomLevel: "",
      resource: { type: courseFiles[0].fileType, ref: courseFiles[0].url },
      lessonsCount: courseFiles.length,
      courseFiles,
      videos: [],
      quizzes
    });

    console.log(`Added: ${lesson.id} ${lesson.name} — ${courseFiles.length} file, ${questions.length} quiz question(s)`);
    added++;
  }

  if (added > 0) {
    moduleDoc.markModified("acquis");
    await moduleDoc.save();
  }

  console.log(`\nDone. ${added} sous-acquis added to ${ACQUIS_ID}.`);
  console.log("Final acquis 3 sous-acquis:", (acquis.sousAcquis || []).map((s: any) => s.id).join(", "));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
