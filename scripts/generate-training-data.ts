/**
 * generate-training-data.ts
 *
 * Produces data/student_analytics.csv — the labeled dataset the risk model is
 * trained on. Unlike the previous opaque CSV, this generator is:
 *
 *   1. Reproducible (fixed seed) so retraining is deterministic.
 *   2. Transparent — the label comes from a documented latent "success
 *      propensity" model, so the relationships the Random Forest learns are
 *      pedagogically sensible instead of arbitrary noise.
 *   3. Extensible — real students are pulled from MongoDB (when reachable),
 *      their 7 features computed with the SAME code the server uses, and
 *      appended with a proxy label. As true end-of-term outcomes become
 *      available they can replace the proxy here.
 *
 * Run with:  npm run generate:training-data   (then npm run train:model)
 *
 * NOTE on the proxy label: until real "did the student catch up?" outcomes
 * exist, both the synthetic label and the real-student proxy are heuristics.
 * They encode the intended risk logic; they are not ground truth. This is
 * called out honestly so the model's limits are understood.
 */

import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { User } from "../src/models/User";
import { StudentProfile } from "../src/models/StudentProfile";
import { ClassRoom } from "../src/models/ClassRoom";
import { CurriculumModule } from "../src/models/CurriculumModule";
import {
  PREDICTION_FEATURE_KEYS,
  PREDICTION_FEATURE_RANGES,
  computePredictionFeatures,
  type PredictionFeatures
} from "../src/services/prediction/features";

const OUT_PATH = path.join(process.cwd(), "data", "student_analytics.csv");
const SYNTHETIC_COUNT = 1200;
const SEED = 42;

// ── Deterministic PRNG (mulberry32) so the dataset is reproducible ──────────
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**
 * Latent success model: combines the features into a single "propensity to
 * catch up" score in roughly [0, 1], then labels 1 if (score + noise) crosses
 * a threshold. The signs encode the intended relationships:
 *   - low delay, high pace, high score, frequent logins, low gap,
 *     recent activity, few weak skills  ->  likely catches up.
 */
function successPropensity(f: PredictionFeatures): number {
  const norm = {
    delay: 1 - f.delayWeeks / 12, // 1 = on time
    pace: f.completionPace / 5,
    score: f.averageScore / 100,
    login: f.loginFrequency / 14,
    coverage: 1 - f.gapDepth, // 1 = fully covered
    recency: f.recencyRatio,
    strength: 1 - f.weakSkillRatio // 1 = no weak skills
  };

  // Weighted sum (weights sum to 1). Score & recency matter most.
  const raw =
    0.24 * norm.score +
    0.2 * norm.recency +
    0.16 * norm.pace +
    0.14 * norm.delay +
    0.12 * norm.strength +
    0.08 * norm.coverage +
    0.06 * norm.login;

  return Math.max(0, Math.min(1, raw));
}

function labelFromPropensity(propensity: number, rng: () => number): number {
  // Logistic-ish threshold at 0.5 with realistic noise so classes overlap
  // (a model that perfectly separates synthetic data would just memorise it).
  const noise = (rng() - 0.5) * 0.35;
  return propensity + noise >= 0.5 ? 1 : 0;
}

/**
 * Exam-grade label (/20) from the same latent model, so the regression target
 * is consistent with the classification label. The grade leans on the overall
 * propensity but keeps a direct link to quiz performance (averageScore), plus
 * noise so the mapping isn't a deterministic curve the forest can memorise.
 */
function gradeFromPropensity(propensity: number, f: PredictionFeatures, rng: () => number): number {
  const base = 0.7 * propensity + 0.3 * (f.averageScore / 100);
  const noise = (rng() - 0.5) * 3.5; // ±1.75 points
  const grade = 1 + base * 18 + noise;
  return Math.max(0, Math.min(20, Math.round(grade * 4) / 4));
}

type LabeledRow = { features: PredictionFeatures; label: number; grade: number };

function generateSyntheticRow(rng: () => number): LabeledRow {
  const features: PredictionFeatures = {
    delayWeeks: randRange(rng, 0, 12),
    completionPace: randRange(rng, 0, 5),
    averageScore: randRange(rng, 0, 100),
    loginFrequency: randRange(rng, 0, 14),
    gapDepth: randRange(rng, 0, 1),
    recencyRatio: randRange(rng, 0, 1),
    weakSkillRatio: randRange(rng, 0, 1)
  };
  const propensity = successPropensity(features);
  return {
    features,
    label: labelFromPropensity(propensity, rng),
    grade: gradeFromPropensity(propensity, features, rng)
  };
}

/** Proxy label for a real student (heuristic until true outcomes exist). */
function proxyLabel(f: PredictionFeatures): number {
  return successPropensity(f) >= 0.5 ? 1 : 0;
}

/** Proxy grade for a real student — same mapping, no noise (deterministic). */
function proxyGrade(f: PredictionFeatures): number {
  const base = 0.7 * successPropensity(f) + 0.3 * (f.averageScore / 100);
  return Math.max(0, Math.min(20, Math.round((1 + base * 18) * 4) / 4));
}

async function resolveTotalSubAcquis(): Promise<number> {
  const modules = await CurriculumModule.find().select({ acquis: 1 }).lean();
  let count = 0;
  for (const moduleDoc of modules as any[]) {
    for (const acquis of Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : []) {
      count += Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis.length : 0;
    }
  }
  return count > 0 ? count : 42;
}

async function collectRealStudentRows(): Promise<LabeledRow[]> {
  const rows: LabeledRow[] = [];
  try {
    const totalSubAcquis = await resolveTotalSubAcquis();
    const profiles = await StudentProfile.find()
      .select({ identifier: 1, loginCount: 1, lastLoginDate: 1, createdAt: 1, classId: 1 })
      .lean();
    if (!profiles.length) return rows;

    const identifiers = profiles.map((p: any) => p.identifier).filter(Boolean);
    const users = await User.find({ identifier: { $in: identifiers } })
      .select({ identifier: 1, progress: 1 })
      .lean();
    const userByIdentifier = new Map(users.map((u: any) => [u.identifier, u]));

    const classes = await ClassRoom.find().select({ scheduleStartDate: 1 }).lean();
    const scheduleByClassId = new Map(classes.map((c: any) => [String(c._id), c.scheduleStartDate || null]));

    const now = Date.now();
    for (const profile of profiles as any[]) {
      const user = userByIdentifier.get(profile.identifier);
      const progress = user?.progress || {};
      const quizResults = Array.isArray(progress.quizResults) ? progress.quizResults : [];
      const scheduleStart = scheduleByClassId.get(String(profile.classId || "")) || null;

      const features = computePredictionFeatures({
        completedCount: Array.isArray(progress.completedLessonKeys) ? progress.completedLessonKeys.length : 0,
        totalSubAcquis,
        quizScores: quizResults.map((r: any) => Number(r?.score)),
        quizTimestamps: quizResults
          .map((r: any) => (r?.submittedAt ? new Date(r.submittedAt).getTime() : NaN))
          .filter((t: number) => Number.isFinite(t)),
        loginCount: Number(profile.loginCount || 0),
        createdAt: profile.createdAt ? new Date(profile.createdAt).getTime() : now,
        lastLoginAt: profile.lastLoginDate ? new Date(profile.lastLoginDate).getTime() : null,
        scheduleStartAt: scheduleStart ? new Date(scheduleStart).getTime() : null,
        now
      });

      rows.push({ features, label: proxyLabel(features), grade: proxyGrade(features) });
    }
  } catch (error) {
    console.warn("[gen] Could not collect real students (continuing with synthetic only):", error);
  }
  return rows;
}

async function main(): Promise<void> {
  const rng = makeRng(SEED);

  console.log(`[gen] Generating ${SYNTHETIC_COUNT} synthetic rows (seed ${SEED}) …`);
  const rows: LabeledRow[] = [];
  for (let i = 0; i < SYNTHETIC_COUNT; i++) rows.push(generateSyntheticRow(rng));

  // Blend in real students when the database is reachable.
  if (env.mongodbUri) {
    try {
      await mongoose.connect(env.mongodbUri);
      const realRows = await collectRealStudentRows();
      if (realRows.length) {
        console.log(`[gen] Blended in ${realRows.length} real student(s) with proxy labels.`);
        rows.push(...realRows);
      } else {
        console.log("[gen] No real students found — synthetic dataset only.");
      }
    } catch (error) {
      console.warn("[gen] MongoDB unavailable — synthetic dataset only:", error);
    } finally {
      await mongoose.disconnect().catch(() => undefined);
    }
  }

  const header = [...PREDICTION_FEATURE_KEYS, "caughtUp", "examGrade"].join(",");
  const lines = rows.map((row) => {
    const vals = PREDICTION_FEATURE_KEYS.map((key) => {
      const [min, max] = PREDICTION_FEATURE_RANGES[key];
      const v = Math.max(min, Math.min(max, Number(row.features[key]) || 0));
      return (Math.round(v * 1000) / 1000).toString();
    });
    return [...vals, row.label, row.grade].join(",");
  });

  await fs.writeFile(OUT_PATH, header + "\n" + lines.join("\n") + "\n", "utf8");

  const positives = rows.filter((r) => r.label === 1).length;
  console.log(`[gen] Wrote ${rows.length} rows to ${OUT_PATH}`);
  console.log(`[gen] Class balance — caughtUp=1: ${positives} (${((positives / rows.length) * 100).toFixed(1)}%)`);
  console.log(`[gen] Columns: ${header}`);
  console.log("[gen] Next: npm run train:model");
}

main().catch((error) => {
  console.error("[gen] ERROR:", error);
  process.exit(1);
});
