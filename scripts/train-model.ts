/**
 * train-model.ts
 *
 * Run once with:  npm run train:model
 *
 * Reads data/student_analytics.csv, trains a Random Forest classifier,
 * then writes the serialised model to data/rf-model.json so the server
 * can load it instantly on every subsequent startup (no retraining needed).
 */

import fs from "node:fs/promises";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RandomForestClassifier } = require("ml-random-forest");

const CSV_PATH  = path.join(process.cwd(), "data", "student_analytics.csv");
const MODEL_OUT = path.join(process.cwd(), "data", "rf-model.json");

// ---------------------------------------------------------------------------
// CSV parser (no external dependency needed)
// ---------------------------------------------------------------------------
function parseCSV(raw: string): { X: number[][]; y: number[] } {
  const lines = raw.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());

  console.log(`[train] Columns detected: ${header.join(", ")}`);

  const featureCols = [
    "delayWeeks",
    "completionPace",
    "averageScore",
    "loginFrequency",
    "gapDepth",
    "recencyRatio",
    "weakSkillRatio"
  ];
  const labelCol    = "caughtUp";

  const featureIdxs = featureCols.map((col) => {
    const idx = header.indexOf(col);
    if (idx === -1) throw new Error(`Column not found in CSV: "${col}"`);
    return idx;
  });
  const labelIdx = header.indexOf(labelCol);
  if (labelIdx === -1) throw new Error(`Label column not found in CSV: "${labelCol}"`);

  const X: number[][] = [];
  const y: number[]   = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < header.length) { skipped++; continue; }

    const row   = featureIdxs.map((idx) => parseFloat(parts[idx]));
    const label = parseInt(parts[labelIdx], 10);

    if (row.some(isNaN) || isNaN(label)) { skipped++; continue; }

    X.push(row);
    y.push(label);
  }

  if (skipped > 0) console.warn(`[train] Skipped ${skipped} malformed rows.`);
  return { X, y };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[train] Reading dataset from: ${CSV_PATH}`);
  const raw = await fs.readFile(CSV_PATH, "utf8");

  const { X, y } = parseCSV(raw);
  console.log(`[train] Loaded ${X.length} samples.`);

  // Class distribution
  const positives = y.filter((v) => v === 1).length;
  console.log(`[train] Class distribution — caught up: ${positives} (${((positives/y.length)*100).toFixed(1)}%)  |  did not: ${y.length - positives} (${(((y.length-positives)/y.length)*100).toFixed(1)}%)`);

  console.log("[train] Training Random Forest (100 trees, max depth 10, seed 42) …");
  const t0 = Date.now();

  const clf = new RandomForestClassifier({
    nEstimators:   100,
    maxDepth:      10,
    minNumSamples: 3,
    seed:          42,
  });

  clf.train(X, y);

  const elapsed = Date.now() - t0;
  console.log(`[train] Training complete in ${elapsed}ms.`);

  // Quick accuracy check on training set
  const preds: number[] = clf.predict(X);
  const correct = preds.filter((p: number, i: number) => p === y[i]).length;
  console.log(`[train] Training accuracy: ${((correct / y.length) * 100).toFixed(1)}% (sanity check – use cross-validation for real accuracy)`);

  // Serialise and save
  const modelJson = clf.toJSON();
  await fs.writeFile(MODEL_OUT, JSON.stringify(modelJson), "utf8");
  console.log(`[train] ✅ Model saved to: ${MODEL_OUT}`);
}

main().catch((err) => {
  console.error("[train] ERROR:", err);
  process.exit(1);
});
