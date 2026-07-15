/**
 * test-on-fresh-data.ts
 *
 * Generates a FRESH synthetic dataset with a different seed (samples the models
 * never saw) from the same latent model as the training generator, then
 * evaluates the ALREADY-TRAINED production models (data/rf-model.json and
 * data/rf-grade-model.json) on it. This is a true out-of-sample test of the
 * deployed models — no retraining.
 *
 * Run:  npm run test:fresh-data
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  PREDICTION_FEATURE_KEYS,
  type PredictionFeatureKey
} from "../src/services/prediction/features";
import {
  successPropensity,
  labelFromPropensity,
  gradeFromPropensity,
  drawSyntheticFeatures
} from "./lib/syntheticLabel";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RandomForestClassifier, RandomForestRegression } = require("ml-random-forest");

const N = 3000;
const SEED = 20260708; // different from the training seed (42)

// Feature list and latent label model are IMPORTED, never re-typed. They used to be
// copied here with a comment claiming they were "identical" to the generator's; the
// copies drifted the moment attention was added, and this test silently began
// scoring the models against a target they were never trained on.
const ORDER: readonly PredictionFeatureKey[] = PREDICTION_FEATURE_KEYS;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rr = (rng: () => number, min: number, max: number) => min + rng() * (max - min);


function classMetrics(yTrue: number[], yPred: number[]) {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (let i = 0; i < yTrue.length; i++) {
    if (yPred[i] === 1 && yTrue[i] === 1) tp++;
    else if (yPred[i] === 0 && yTrue[i] === 0) tn++;
    else if (yPred[i] === 1 && yTrue[i] === 0) fp++;
    else fn++;
  }
  const acc = (tp + tn) / yTrue.length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { acc, precision, recall, f1, tp, tn, fp, fn };
}
function auc(yTrue: number[], s: number[]): number {
  const pos = s.filter((_, i) => yTrue[i] === 1), neg = s.filter((_, i) => yTrue[i] === 0);
  if (!pos.length || !neg.length) return 0.5;
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
}
function regMetrics(yTrue: number[], yPred: number[]) {
  const n = yTrue.length, mean = yTrue.reduce((a, b) => a + b, 0) / n;
  let ae = 0, se = 0, ss = 0;
  for (let i = 0; i < n; i++) { ae += Math.abs(yPred[i] - yTrue[i]); se += (yPred[i] - yTrue[i]) ** 2; ss += (yTrue[i] - mean) ** 2; }
  return { mae: ae / n, rmse: Math.sqrt(se / n), r2: ss ? 1 - se / ss : 0 };
}

async function main() {
  const rng = mulberry32(SEED);
  const X: number[][] = [], yLabel: number[] = [], yGrade: number[] = [];
  for (let i = 0; i < N; i++) {
    const f = drawSyntheticFeatures(rng);
    const p = successPropensity(f);
    X.push(ORDER.map((k) => f[k]));
    yLabel.push(labelFromPropensity(p, rng));
    yGrade.push(gradeFromPropensity(p, f, rng));
  }
  const pos = yLabel.filter((v) => v === 1).length;
  console.log(`[fresh] Generated ${N} NEW rows (seed ${SEED}, unseen by the models). caughtUp=1: ${pos} (${((pos / N) * 100).toFixed(1)}%)\n`);

  const clf = RandomForestClassifier.load(JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "rf-model.json"), "utf8")));
  const reg = RandomForestRegression.load(JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "rf-grade-model.json"), "utf8")));

  const cm = classMetrics(yLabel, clf.predict(X));
  console.log(`═══ RISK CLASSIFIER — production model on fresh data (n=${N}) ═══`);
  console.log(`  Accuracy : ${(cm.acc * 100).toFixed(1)}%`);
  console.log(`  Precision: ${(cm.precision * 100).toFixed(1)}%   Recall: ${(cm.recall * 100).toFixed(1)}%   F1: ${(cm.f1 * 100).toFixed(1)}%`);
  console.log(`  ROC-AUC  : ${auc(yLabel, clf.predictProbability(X, 1)).toFixed(3)}`);
  console.log(`  Confusion: TP=${cm.tp} TN=${cm.tn} FP=${cm.fp} FN=${cm.fn}`);

  const rm = regMetrics(yGrade, reg.predict(X));
  console.log(`\n═══ GRADE REGRESSOR — production model on fresh data (n=${N}) ═══`);
  console.log(`  MAE : ${rm.mae.toFixed(2)} points/20    RMSE: ${rm.rmse.toFixed(2)}    R²: ${rm.r2.toFixed(3)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
