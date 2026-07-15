/**
 * ablate-attention.ts
 *
 * Does the attention signal actually earn its place in the model?
 *
 * Trains the risk classifier and the grade regressor twice on the SAME rows and
 * the SAME splits — once with all features, once with the two attention columns
 * removed — and reports the difference. Repeated over several seeds because a
 * single 80/20 split of 1234 noisy rows moves by a point or two on its own.
 *
 * Run: npx tsx scripts/ablate-attention.ts
 *
 * Read the number honestly: the labels are synthetic, and the attention→success
 * link inside them is an assumption we wrote ourselves (scripts/lib/syntheticLabel.ts).
 * This measures "can the forest recover the relationship we asserted", NOT "does
 * focus predict real exam outcomes". Only real end-of-term results can answer that.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { PREDICTION_FEATURE_KEYS } from "../src/services/prediction/features";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RandomForestClassifier, RandomForestRegression } = require("ml-random-forest");

const CSV = path.join(process.cwd(), "data", "student_analytics.csv");
const SEEDS = [1, 2, 3];
const ATTENTION_COLS = ["avgFocusScore", "hasAttentionData"];

function shuffle<T>(arr: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rng = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function auc(yTrue: number[], score: number[]): number {
  const pos = score.filter((_, i) => yTrue[i] === 1);
  const neg = score.filter((_, i) => yTrue[i] === 0);
  if (!pos.length || !neg.length) return 0.5;
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
}

async function main(): Promise<void> {
  const raw = await fs.readFile(CSV, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  const li = header.indexOf("caughtUp");
  const gi = header.indexOf("examGrade");

  const rows = lines.slice(1).map((line) => {
    const p = line.split(",");
    return {
      feat: Object.fromEntries(PREDICTION_FEATURE_KEYS.map((k) => [k, parseFloat(p[header.indexOf(k)])])),
      label: parseInt(p[li], 10),
      grade: parseFloat(p[gi])
    };
  });

  const configs: Array<{ name: string; cols: string[] }> = [
    { name: "WITHOUT attention (7 features)", cols: PREDICTION_FEATURE_KEYS.filter((k) => !ATTENTION_COLS.includes(k)) },
    { name: "WITH attention    (9 features)", cols: [...PREDICTION_FEATURE_KEYS] }
  ];

  const results: Record<string, { acc: number[]; auc: number[]; mae: number[] }> = {};
  for (const cfg of configs) results[cfg.name] = { acc: [], auc: [], mae: [] };

  for (const seed of SEEDS) {
    const shuffled = shuffle(rows, seed);
    const cut = Math.floor(shuffled.length * 0.8);
    const train = shuffled.slice(0, cut);
    const test = shuffled.slice(cut);

    for (const cfg of configs) {
      const Xtr = train.map((r) => cfg.cols.map((c) => (r.feat as any)[c]));
      const Xte = test.map((r) => cfg.cols.map((c) => (r.feat as any)[c]));

      const clf = new RandomForestClassifier({
        nEstimators: 100, maxDepth: 10, seed, treeOptions: { maxDepth: 10 }, useSampleBagging: true
      });
      clf.train(Xtr, train.map((r) => r.label));
      const pred = clf.predict(Xte);
      const yTest = test.map((r) => r.label);
      const acc = pred.reduce((n: number, p: number, i: number) => n + (p === yTest[i] ? 1 : 0), 0) / yTest.length;
      results[cfg.name].acc.push(acc);
      results[cfg.name].auc.push(auc(yTest, clf.predictProbability(Xte, 1)));

      const reg = new RandomForestRegression({
        nEstimators: 100, maxDepth: 10, seed, treeOptions: { maxDepth: 10 }, useSampleBagging: true
      });
      reg.train(Xtr, train.map((r) => r.grade));
      const gp = reg.predict(Xte);
      const mae = gp.reduce((s: number, g: number, i: number) => s + Math.abs(g - test[i].grade), 0) / test.length;
      results[cfg.name].mae.push(mae);
    }
    console.log(`  seed ${seed} done`);
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  console.log(`\n═══ ABLATION — same rows, same splits, ${SEEDS.length} seeds ═══\n`);
  console.log("                                   accuracy      ROC-AUC     grade MAE");
  for (const cfg of configs) {
    const r = results[cfg.name];
    console.log(
      `  ${cfg.name}   ${(mean(r.acc) * 100).toFixed(1)}%        ${mean(r.auc).toFixed(3)}       ${mean(r.mae).toFixed(2)}`
    );
  }
  const a = results[configs[0].name];
  const b = results[configs[1].name];
  console.log(
    `\n  attention adds:                  ${((mean(b.acc) - mean(a.acc)) * 100 >= 0 ? "+" : "")}${((mean(b.acc) - mean(a.acc)) * 100).toFixed(1)} pts    ` +
    `${(mean(b.auc) - mean(a.auc) >= 0 ? "+" : "")}${(mean(b.auc) - mean(a.auc)).toFixed(3)}      ` +
    `${(mean(b.mae) - mean(a.mae) >= 0 ? "+" : "")}${(mean(b.mae) - mean(a.mae)).toFixed(2)}`
  );
  console.log("\n  (MAE: lower is better. Labels are synthetic — see the header of this file.)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
