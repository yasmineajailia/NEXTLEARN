/**
 * resync-quizzes.ts
 *
 * Re-imports every sous-acquis's quiz in the "programmation-c" module from its
 * source .normalized.json file in content/Support_Cours_Préparation, replacing
 * ONLY the quiz array (course files, videos, names, etc. are preserved).
 *
 * A sous-acquis is skipped (its existing DB quiz kept) when no .normalized.json
 * source is found, or the source has no valid questions — so nothing is wiped
 * by accident.
 *
 * The current DB quizzes are dumped to data/quizzes-backup-<timestamp>.json
 * first, so the operation is reversible.
 *
 * Run:  npm run resync:quizzes
 */

import path from "path";
import { promises as fs } from "fs";
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { CurriculumModule } from "../src/models/CurriculumModule";

const SUPPORT_ROOT = path.join(process.cwd(), "content", "Support_Cours_Préparation");
const MODULE_ID = "programmation-c";

// Sous-acquis whose quiz lives in the shared "Appliquer Structures itératives" folder.
const ITER_DIR = path.join(SUPPORT_ROOT, "3", "Appliquer Structures itératives");
const ITER_MAP: Record<string, string> = {
  "3.5": "Quizz_for.normalized.json",
  "3.6": "Quizz_while.normalized.json",
  "3.7": "Quizz_do_while.normalized.json"
};

function normalizeWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function sanitizePathSegment(value: string): string {
  const n = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return n || "item";
}
function createStableId(prefix: string, value: string): string {
  return `${prefix}-${sanitizePathSegment(value).toLowerCase()}`;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Mirrors parseNormalizedQuizJson + toCurriculumQuestion from web.ts. */
function parseQuizJson(raw: string): Array<{ prompt: string; options: string[]; correctAnswerIndex: number | null }> {
  const parsed = JSON.parse(raw) as { questions?: Array<any> };
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  return questions
    .map((q) => {
      const prompt = normalizeWhitespace(String(q?.prompt ?? ""));
      const options = Array.isArray(q?.options) ? q.options.map((o: any) => normalizeWhitespace(String(o))).filter(Boolean) : [];
      const raw = q?.correctOptionIndex;
      const idx = typeof raw === "number" && Number.isFinite(raw) ? Number(raw) : null;
      const bounded = idx !== null && idx >= 0 && idx < options.length ? idx : null;
      return { prompt, options, correctAnswerIndex: bounded };
    })
    .filter((q) => q.prompt.length > 0 && q.options.length >= 2);
}

/** Locates the .normalized.json for a sous-acquis id, or null. */
async function findQuizFile(subId: string): Promise<string | null> {
  if (ITER_MAP[subId]) {
    const p = path.join(ITER_DIR, ITER_MAP[subId]);
    return (await exists(p)) ? p : null;
  }
  const prefix = subId.split(".")[0];
  const subRoot = path.join(SUPPORT_ROOT, prefix, subId);
  let dirs;
  try { dirs = await fs.readdir(subRoot, { withFileTypes: true }); } catch { return null; }
  const quizDir = dirs.find((d) => d.isDirectory() && ["quiz", "quizz"].includes(d.name.toLowerCase()));
  if (!quizDir) return null;
  const quizPath = path.join(subRoot, quizDir.name);
  const files = await fs.readdir(quizPath).catch(() => [] as string[]);
  const preferred = files.find((f) => f.toLowerCase() === `${subId.toLowerCase()}.normalized.json`);
  const anyNorm = files.find((f) => f.toLowerCase().endsWith(".normalized.json"));
  const chosen = preferred || anyNorm;
  return chosen ? path.join(quizPath, chosen) : null;
}

async function main(): Promise<void> {
  if (!env.mongodbUri) throw new Error("MONGODB_URI environment variable is not set");
  await mongoose.connect(env.mongodbUri);

  const moduleDoc: any = await CurriculumModule.findOne({ id: MODULE_ID });
  if (!moduleDoc) throw new Error(`Module "${MODULE_ID}" not found`);

  const acquisList: any[] = Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : [];

  // ── Backup current quizzes ────────────────────────────────────────────────
  const backup = acquisList.flatMap((ac) =>
    (ac.sousAcquis || []).map((sa: any) => ({
      subAcquisId: sa.id,
      quizzes: JSON.parse(JSON.stringify(sa.quizzes || []))
    }))
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(process.cwd(), "data", `quizzes-backup-${stamp}.json`);
  await fs.writeFile(backupPath, JSON.stringify(backup, null, 2), "utf8");
  console.log(`[resync] Backed up current quizzes → ${backupPath}`);

  let updated = 0;
  let skippedNoFile = 0;
  let skippedEmpty = 0;

  for (const acquis of acquisList) {
    for (const sa of acquis.sousAcquis || []) {
      const file = await findQuizFile(String(sa.id));
      if (!file) {
        skippedNoFile++;
        continue;
      }
      let questions;
      try {
        questions = parseQuizJson(await fs.readFile(file, "utf8"));
      } catch (err) {
        console.warn(`[resync] ${sa.id}: failed to parse ${path.basename(file)} — kept existing.`, err);
        continue;
      }
      if (!questions.length) {
        skippedEmpty++;
        console.warn(`[resync] ${sa.id}: source has no valid questions — kept existing.`);
        continue;
      }

      const oldCount = (sa.quizzes || []).reduce((n: number, q: any) => n + (q.questions?.length || 0), 0);
      const existingId = sa.quizzes?.[0]?.id;
      sa.quizzes = [
        {
          id: existingId || createStableId("quiz", String(sa.id)),
          type: "qcm",
          title: `Quiz ${sa.id}`,
          questions
        }
      ];
      updated++;
      console.log(`[resync] ${sa.id}: ${oldCount} → ${questions.length} question(s)  (${path.basename(file)})`);
    }
  }

  if (updated > 0) {
    moduleDoc.markModified("acquis");
    await moduleDoc.save();
  }

  console.log(`\n[resync] Done. Updated ${updated} quiz(zes). Skipped ${skippedNoFile} (no source file), ${skippedEmpty} (empty source).`);
  console.log(`[resync] Restore with the backup file if needed: ${backupPath}`);
}

main()
  .catch((error) => { console.error("[resync] ERROR:", error); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect().catch(() => undefined); });
