/**
 * evaluate-models.ts
 *
 * Proper out-of-sample evaluation of both Random Forests on
 * data/student_analytics.csv — a held-out 80/20 test split plus 5-fold
 * cross-validation, using the SAME ml-random-forest hyperparameters as
 * production. Reports real generalization metrics (not training accuracy).
 *
 * Run:  npm run evaluate:models
 */

import fs from "node:fs/promises";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RandomForestClassifier, RandomForestRegression } = require("ml-random-forest");

const CSV_PATH = path.join(process.cwd(), "data", "student_analytics.csv");
const RF_OPTS = { nEstimators: 100, maxDepth: 10, minNumSamples: 3, seed: 42 };
const FEATURES = ["delayWeeks", "completionPace", "averageScore", "loginFrequency", "gapDepth", "recencyRatio", "weakSkillRatio"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Row = { x: number[]; label: number; grade: number };

async function loadRows(): Promise<Row[]> {
  const raw = await fs.readFile(CSV_PATH, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  const fi = FEATURES.map((c) => header.indexOf(c));
  const li = header.indexOf("caughtUp");
  const gi = header.indexOf("examGrade");
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    const x = fi.map((idx) => parseFloat(p[idx]));
    const label = parseInt(p[li], 10);
    const grade = parseFloat(p[gi]);
    if (x.some(Number.isNaN) || Number.isNaN(label)) continue;
    rows.push({ x, label, grade });
  }
  return rows;
}

// ── Classification metrics ──
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

function auc(yTrue: number[], scores: number[]): number {
  const pos = scores.filter((_, i) => yTrue[i] === 1);
  const neg = scores.filter((_, i) => yTrue[i] === 0);
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// ── Regression metrics ──
function regMetrics(yTrue: number[], yPred: number[]) {
  const n = yTrue.length;
  const mean = yTrue.reduce((a, b) => a + b, 0) / n;
  let ae = 0, se = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    ae += Math.abs(yPred[i] - yTrue[i]);
    se += (yPred[i] - yTrue[i]) ** 2;
    ss += (yTrue[i] - mean) ** 2;
  }
  return { mae: ae / n, rmse: Math.sqrt(se / n), r2: ss ? 1 - se / ss : 0 };
}

function stats(vals: number[]) {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
  return { m, sd };
}

async function main() {
  const all = shuffled(await loadRows(), mulberry32(2024));
  console.log(`[eval] ${all.length} rows, ${FEATURES.length} features. Labels are synthetic/proxy — read the caveat.\n`);

  // ── Held-out 80/20 ──
  const cut = Math.floor(all.length * 0.8);
  const train = all.slice(0, cut), test = all.slice(cut);

  const clf = new RandomForestClassifier(RF_OPTS);
  clf.train(train.map((r) => r.x), train.map((r) => r.label));
  const cPred: number[] = clf.predict(test.map((r) => r.x));
  const cScore: number[] = clf.predictProbability(test.map((r) => r.x), 1);
  const cm = classMetrics(test.map((r) => r.label), cPred);

  console.log("═══ RISK CLASSIFIER (catch-up)  —  held-out test (n=" + test.length + ") ═══");
  console.log(`  Accuracy : ${(cm.acc * 100).toFixed(1)}%`);
  console.log(`  Precision: ${(cm.precision * 100).toFixed(1)}%   Recall: ${(cm.recall * 100).toFixed(1)}%   F1: ${(cm.f1 * 100).toFixed(1)}%`);
  console.log(`  ROC-AUC  : ${auc(test.map((r) => r.label), cScore).toFixed(3)}`);
  console.log(`  Confusion: TP=${cm.tp} TN=${cm.tn} FP=${cm.fp} FN=${cm.fn}`);

  const reg = new RandomForestRegression(RF_OPTS);
  reg.train(train.map((r) => r.x), train.map((r) => r.grade));
  const rPred: number[] = reg.predict(test.map((r) => r.x));
  const rm = regMetrics(test.map((r) => r.grade), rPred);
  console.log("\n═══ GRADE REGRESSOR (/20)  —  held-out test (n=" + test.length + ") ═══");
  console.log(`  MAE : ${rm.mae.toFixed(2)} points/20    RMSE: ${rm.rmse.toFixed(2)}    R²: ${rm.r2.toFixed(3)}`);

  // ── 5-fold cross-validation ──
  const K = 5;
  const accs: number[] = [], maes: number[] = [];
  for (let k = 0; k < K; k++) {
    const te = all.filter((_, i) => i % K === k);
    const tr = all.filter((_, i) => i % K !== k);
    const c = new RandomForestClassifier(RF_OPTS);
    c.train(tr.map((r) => r.x), tr.map((r) => r.label));
    accs.push(classMetrics(te.map((r) => r.label), c.predict(te.map((r) => r.x))).acc);
    const g = new RandomForestRegression(RF_OPTS);
    g.train(tr.map((r) => r.x), tr.map((r) => r.grade));
    maes.push(regMetrics(te.map((r) => r.grade), g.predict(te.map((r) => r.x))).mae);
    process.stdout.write(`  fold ${k + 1}/${K} done\r`);
  }
  const a = stats(accs), me = stats(maes);
  console.log("\n═══ 5-FOLD CROSS-VALIDATION ═══");
  console.log(`  Classifier accuracy: ${(a.m * 100).toFixed(1)}% ± ${(a.sd * 100).toFixed(1)}`);
  console.log(`  Regressor MAE      : ${me.m.toFixed(2)} ± ${me.sd.toFixed(2)} points/20`);
}

main().catch((e) => { console.error(e); process.exit(1); });
