/**
 * train-grade-model.ts
 *
 * Run with:  npm run train:grade-model
 *
 * Trains a Random Forest REGRESSION model that predicts the student's expected
 * exam grade (/20) from the same 7 features as the risk classifier, using the
 * `examGrade` column of data/student_analytics.csv, and saves it to
 * data/rf-grade-model.json for instant loading at server startup.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { PREDICTION_FEATURE_KEYS } from "../src/services/prediction/features";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RandomForestRegression } = require("ml-random-forest");

const CSV_PATH  = path.join(process.cwd(), "data", "student_analytics.csv");
const MODEL_OUT = path.join(process.cwd(), "data", "rf-grade-model.json");

function parseCSV(raw: string): { X: number[][]; y: number[] } {
  const lines = raw.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());

  // Imported, never re-typed. Hardcoding this list is how the models ended up
  // trained on 7 features while the server fed them 9: the extra columns were
  // silently ignored and attention had no effect on any prediction.
  const featureCols: readonly string[] = PREDICTION_FEATURE_KEYS;
  const labelCol = "examGrade";

  const featureIdxs = featureCols.map((col) => {
    const idx = header.indexOf(col);
    if (idx === -1) throw new Error(`Column not found in CSV: "${col}"`);
    return idx;
  });
  const labelIdx = header.indexOf(labelCol);
  if (labelIdx === -1) {
    throw new Error(`Label column "${labelCol}" not found — run npm run generate:training-data first.`);
  }

  const X: number[][] = [];
  const y: number[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < header.length) { skipped++; continue; }
    const row = featureIdxs.map((idx) => parseFloat(parts[idx]));
    const grade = parseFloat(parts[labelIdx]);
    if (row.some(isNaN) || isNaN(grade)) { skipped++; continue; }
    X.push(row);
    y.push(grade);
  }

  if (skipped > 0) console.warn(`[train-grade] Skipped ${skipped} malformed rows.`);
  return { X, y };
}

async function main() {
  console.log(`[train-grade] Reading dataset from: ${CSV_PATH}`);
  const raw = await fs.readFile(CSV_PATH, "utf8");
  const { X, y } = parseCSV(raw);
  console.log(`[train-grade] Loaded ${X.length} samples. Grade mean: ${(y.reduce((a, b) => a + b, 0) / y.length).toFixed(2)}/20`);

  console.log("[train-grade] Training Random Forest regression (100 trees, max depth 10, seed 42) …");
  const t0 = Date.now();

  const reg = new RandomForestRegression({
    nEstimators:   100,
    maxDepth:      10,
    minNumSamples: 3,
    seed:          42,
  });
  reg.train(X, y);

  console.log(`[train-grade] Training complete in ${Date.now() - t0}ms.`);

  // In-sample fit (sanity check only).
  const preds: number[] = reg.predict(X);
  const mae = preds.reduce((s, p, i) => s + Math.abs(p - y[i]), 0) / y.length;
  console.log(`[train-grade] Training MAE: ${mae.toFixed(2)} points /20 (in-sample sanity check)`);

  await fs.writeFile(MODEL_OUT, JSON.stringify(reg.toJSON()), "utf8");
  console.log(`[train-grade] ✅ Model saved to: ${MODEL_OUT}`);

  const featuresOut = path.join(process.cwd(), "data", "model-features.json");
  await fs.writeFile(featuresOut, JSON.stringify([...PREDICTION_FEATURE_KEYS], null, 2), "utf8");
}

main().catch((err) => {
  console.error("[train-grade] ERROR:", err);
  process.exit(1);
});
