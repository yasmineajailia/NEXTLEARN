/**
 * Attaches the PDF renditions of the "Appliquer les structures itératives"
 * decks (generated from the PPTX via LibreOffice) to sous-acquis 3.5/3.6/3.7 of
 * the "programmation-c" module. The PDF is mirrored into the curriculum-media
 * GridFS bucket and inserted FIRST in courseFiles so it becomes the default
 * inline preview (pdf.js), matching lessons 3.1–3.4. The PPTX is kept.
 *
 * Idempotent: a sous-acquis that already has a PDF course file is skipped.
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

const PDFS = [
  { id: "3.5", pdf: "Boucle for.pdf" },
  { id: "3.6", pdf: "Boucle while.pdf" },
  { id: "3.7", pdf: "Boucle do..while.pdf" }
];

function sanitizePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || "item";
}
function createStableId(prefix: string, value: string): string {
  return `${prefix}-${sanitizePathSegment(value).toLowerCase()}`;
}
function buildMediaPublicUrl(fileId: string, filename: string): string {
  return `/api/media/${encodeURIComponent(fileId)}/${encodeURIComponent(filename)}`;
}

async function uploadToGridFs(buffer: Buffer, filename: string, metadata: Record<string, unknown>): Promise<string> {
  if (!mongoose.connection.db) throw new Error("MongoDB connection is not ready");
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
  const uploadStream = bucket.openUploadStream(filename, { metadata: { ...metadata, contentType: "application/pdf" } });
  await new Promise<void>((resolve, reject) => {
    uploadStream.on("finish", () => resolve());
    uploadStream.on("error", reject);
    Readable.from(buffer).pipe(uploadStream);
  });
  return buildMediaPublicUrl(uploadStream.id.toString(), filename);
}

async function main(): Promise<void> {
  if (!env.mongodbUri) throw new Error("MONGODB_URI environment variable is not set");
  await mongoose.connect(env.mongodbUri);

  const moduleDoc: any = await CurriculumModule.findOne({ id: MODULE_ID });
  if (!moduleDoc) throw new Error(`Module "${MODULE_ID}" not found`);
  const acquis = (moduleDoc.acquis || []).find((a: any) => a.id === ACQUIS_ID);
  if (!acquis) throw new Error(`Acquis "${ACQUIS_ID}" not found`);

  let updated = 0;

  for (const entry of PDFS) {
    const sub = (acquis.sousAcquis || []).find((s: any) => String(s.id) === entry.id);
    if (!sub) { console.log(`Skipped (sous-acquis ${entry.id} not found)`); continue; }

    const files: any[] = Array.isArray(sub.courseFiles) ? sub.courseFiles : [];
    const alreadyHasPdf = files.some((f) => String(f.fileType || "").includes("pdf") || String(f.url || "").toLowerCase().includes(".pdf"));
    if (alreadyHasPdf) { console.log(`Skipped (already has PDF): ${entry.id}`); continue; }

    const pdfBuffer = await fs.readFile(path.join(SOURCE_DIR, entry.pdf));
    const mediaUrl = await uploadToGridFs(pdfBuffer, entry.pdf, {
      moduleId: MODULE_ID,
      subAcquisId: entry.id,
      kind: "course-file"
    });
    const title = path.basename(entry.pdf, path.extname(entry.pdf));

    const pdfCourseFile = { id: createStableId("course", mediaUrl), title, url: mediaUrl, fileType: "application/pdf" };

    // PDF first → default inline preview; keep the existing PPTX after it.
    sub.courseFiles = [pdfCourseFile, ...files];
    sub.resource = { type: "application/pdf", ref: mediaUrl };
    sub.lessonsCount = sub.courseFiles.length;

    console.log(`Attached PDF to ${entry.id} — courseFiles now: ${sub.courseFiles.map((f: any) => f.title).join(", ")}`);
    updated++;
  }

  if (updated > 0) {
    moduleDoc.markModified("acquis");
    await moduleDoc.save();
  }
  console.log(`\nDone. ${updated} sous-acquis updated with PDF renditions.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect().catch(() => undefined); });
