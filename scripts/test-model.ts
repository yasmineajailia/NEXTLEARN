/**
 * test-model.ts
 *
 * Run with:  npm run test:model
 *
 * Loads the pre-trained model from data/rf-model.json and runs a set of
 * representative student profiles through it, printing a readable table.
 */

import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RandomForestClassifier } = require("ml-random-forest");

const MODEL_PATH = path.join(process.cwd(), "data", "rf-model.json");

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function predict(clf: any, features: number[]): number {
  const maxValues   = [12, 5, 100, 14, 1, 1, 1];
  const jitterScale = [0.3, 0.1, 2, 0.3, 0.03, 0.03, 0.03];
  const votes = 30;
  let positive = 0;
  for (let i = 0; i < votes; i++) {
    const jittered = features.map((v, idx) => {
      const noise = (Math.random() - 0.5) * jitterScale[idx];
      return clamp(v + noise, 0, maxValues[idx]);
    });
    if (clf.predict([jittered])[0] === 1) positive++;
  }
  return positive / votes;
}

// Features: delayWeeks, completionPace, averageScore, loginFrequency, gapDepth, recencyRatio, weakSkillRatio
const PROFILES = [
  {
    label: "🟢 On-track student",
    description: "No delay, high pace, great scores, active today",
    features: [0, 4.5, 88, 12, 0.05, 0.95, 0.05],
  },
  {
    label: "🟡 Slightly behind but engaged",
    description: "2 weeks late, decent pace, average score, recently active",
    features: [2, 2.8, 65, 7, 0.25, 0.7, 0.3],
  },
  {
    label: "🟡 Behind but recovering",
    description: "4 weeks late, picking up pace, improving, active this week",
    features: [4, 3.2, 72, 9, 0.30, 0.65, 0.25],
  },
  {
    label: "🟠 Moderately at risk",
    description: "6 weeks late, slow pace, low score, fading activity",
    features: [6, 1.2, 40, 3, 0.60, 0.3, 0.6],
  },
  {
    label: "🔴 Highly at risk",
    description: "9 weeks late, almost no activity, very low score, dormant",
    features: [9, 0.5, 22, 1, 0.85, 0.1, 0.85],
  },
  {
    label: "💀 Critical – nearly dropped out",
    description: "12 weeks late, no progress, long dormant",
    features: [12, 0.1, 8, 0.5, 0.97, 0.02, 0.95],
  },
  {
    label: "🔵 Edge case: High delay but very active",
    description: "8 weeks late but studying hard, high scores, active now",
    features: [8, 4.8, 91, 13, 0.08, 0.9, 0.05],
  },
  {
    label: "🔵 Edge case: Low delay but disengaged",
    description: "Only 1 week late but dormant, bad scores",
    features: [1, 0.3, 18, 0.5, 0.80, 0.1, 0.8],
  },
];

function bar(prob: number, width = 20): string {
  const filled = Math.round(prob * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

async function main() {
  if (!fs.existsSync(MODEL_PATH)) {
    console.error("❌ Model not found. Run `npm run train:model` first.");
    process.exit(1);
  }

  console.log("Loading model from data/rf-model.json …\n");
  const raw  = fs.readFileSync(MODEL_PATH, "utf8");
  const json = JSON.parse(raw);
  const clf  = RandomForestClassifier.load(json);
  console.log("✅ Model loaded.\n");

  console.log("=".repeat(70));
  console.log(" RANDOM FOREST — Student Catch-Up Probability Test");
  console.log("=".repeat(70));
  console.log(
    " Features: delay | pace | score | login | gap | recency | weakSkill\n"
  );

  for (const p of PROFILES) {
    const [delay, pace, score, login, gap, recency, weak] = p.features;
    const prob    = predict(clf, p.features);
    const pct     = (prob * 100).toFixed(0).padStart(3);
    const verdict = prob >= 0.65 ? "LIKELY CATCHES UP" : prob >= 0.40 ? "BORDERLINE" : "AT RISK";

    console.log(`${p.label}`);
    console.log(`  ${p.description}`);
    console.log(
      `  Inputs : delay=${delay}w  pace=${pace}  score=${score}  login=${login}/wk  gap=${gap}  recency=${recency}  weak=${weak}`
    );
    console.log(`  Result : ${bar(prob)}  ${pct}%  →  ${verdict}`);
    console.log();
  }

  console.log("=".repeat(70));
  console.log(" Threshold guide:  ≥65% = likely catches up | 40–64% = borderline | <40% = at risk");
  console.log("=".repeat(70));
}

main();
