/**
 * Course file storage and text extraction.
 *
 * Curriculum media lives either under public/ (legacy filesystem files) or in
 * the GridFS "curriculum-media" bucket. These helpers read a course file from
 * wherever it lives and extract plain-text snippets (PDF, DOCX, PPTX) for the
 * chatbot's RAG index. Extraction results are cached per URL.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import mongoose from "mongoose";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import JSZip from "jszip";

import { normalizeWhitespace } from "./textNormalize";

const publicRoot = path.join(process.cwd(), "public");
const supportRoot = path.join(process.cwd(), "content", "Support_Cours_Préparation");
const supportPublicPrefix = "/Support_Cours_Préparation/";

export function inferContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".ogg")) return "video/ogg";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".m4v")) return "video/x-m4v";
  return "application/octet-stream";
}

export function resolveLocalPathFromPublicUrl(url: string): string | null {
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


export const curriculumMediaBucketName = "curriculum-media";
export const courseContentSnippetCache = new Map<string, string[]>();

export function getCurriculumMediaBucket() {
  if (!mongoose.connection.db) {
    throw new Error("MongoDB connection is not ready");
  }

  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: curriculumMediaBucketName
  });
}

export function buildMediaPublicUrl(fileId: string, filename: string): string {
  return `/api/media/${encodeURIComponent(fileId)}/${encodeURIComponent(filename)}`;
}

export function extractGridFsFileIdFromMediaUrl(url: string): string | null {
  const match = String(url || "").match(/^\/api\/media\/([^/]+)\//i);
  return match?.[1] || null;
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
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

export async function readBufferFromCourseFileUrl(url: string): Promise<{ buffer: Buffer; filename: string } | null> {
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

export function normalizeCourseExtractedText(value: string): string {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\t+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

// Returns the trailing ~1 sentence of a chunk so the next chunk can carry a bit
// of overlap. Retrieval quality improves when an idea that straddles a chunk
// boundary still appears (partially) in the neighbouring chunk.
export function ragSnippetOverlapTail(text: string, maxTail = 220): string {
  const slice = String(text || "").slice(-maxTail);
  const match = slice.match(/[.!?]\s+([^]*)$/);
  return normalizeWhitespace(match ? match[1] : slice);
}

export function splitTextIntoRagSnippets(text: string, maxChars = 1000, maxSnippets = 10): string[] {
  const paragraphs = normalizeCourseExtractedText(text)
    .split(/\n\n+/)
    .map((entry) => normalizeWhitespace(entry))
    .filter((entry) => entry.length >= 30);

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

    // Seed the next chunk with the tail of this one for continuity.
    const overlap = ragSnippetOverlapTail(current);
    current = overlap && overlap.length < paragraph.length ? `${overlap}\n${paragraph}` : paragraph;
  }

  if (current && snippets.length < maxSnippets) {
    snippets.push(current);
  }

  return snippets;
}

export async function extractTextFromPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/i)?.[1] ?? "0", 10);
      const numB = parseInt(b.match(/slide(\d+)/i)?.[1] ?? "0", 10);
      return numA - numB;
    });

  const slideTexts: string[] = [];
  for (const slideName of slideNames) {
    const xmlContent = await zip.files[slideName].async("string");
    const textMatches = xmlContent.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
    const slideText = textMatches
      .map((m) => m.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(" ");
    if (slideText.length >= 20) {
      slideTexts.push(slideText);
    }
  }

  return slideTexts.join("\n\n");
}

/**
 * Plain-text extraction for interactive HTML course files, for the chatbot's
 * RAG index. Script/style contents are dropped entirely (not prose, and no
 * reason to index or expose them) before stripping the remaining tags.
 */
export function extractTextFromHtml(buffer: Buffer): string {
  const html = buffer.toString("utf-8");
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return withoutScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

export async function extractCourseContentSnippetsFromUrl(url: string): Promise<string[]> {
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
    let rawText = "";

    if (extension === ".pdf") {
      const parser = new PDFParse({ data: filePayload.buffer });
      const parsed = await parser.getText();
      await parser.destroy().catch(() => undefined);
      rawText = String(parsed.text || "");
    } else if (extension === ".pptx" || extension === ".ppt") {
      rawText = await extractTextFromPptx(filePayload.buffer);
    } else if (extension === ".html" || extension === ".htm") {
      rawText = extractTextFromHtml(filePayload.buffer);
    } else {
      courseContentSnippetCache.set(cacheKey, []);
      return [];
    }

    const snippets = splitTextIntoRagSnippets(rawText, 1000, 12);
    courseContentSnippetCache.set(cacheKey, snippets);
    return snippets;
  } catch (error) {
    console.warn("Failed to extract course content from support file:", cacheKey, error);
    courseContentSnippetCache.set(cacheKey, []);
    return [];
  }
}

export async function uploadBufferToGridFs(params: {
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

export async function mirrorPublicFileToGridFs(publicUrl: string, metadata: Record<string, unknown>): Promise<{ url: string; title: string; fileType: string }> {
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

export function isLocalMediaUrl(url: string): boolean {
  return Boolean(url) && url.startsWith("/") && !url.startsWith("/api/media/") && !url.startsWith("/api/");
}

export function canonicalMediaKey(url: string): string {
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
