/**
 * Populate (or refresh) the student RAG vector store in the Python ML service.
 *
 * The Python `/rag/answer` path only returns grounded answers once ChromaDB is
 * populated. This script reads the persisted curriculum from Mongo and posts it
 * to `POST /rag/reindex`, which fetches the course files, embeds the new chunks
 * (real embedding API calls — needs GEMINI_API_KEY / OPENAI_API_KEY) and upserts
 * them. Dedups on chunk id, so re-running only embeds what changed.
 *
 * Prereqs: the ML service must be running (it is, if `npm run dev` is up; else
 * `npm run shap:serve`).
 *
 * Usage:
 *   npm run reindex:rag            # incremental
 *   npm run reindex:rag -- --reset # wipe the store first
 */
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { SHAP_SERVICE_URL } from "../src/services/prediction/explain";
import { readPersistedCurriculumModules } from "../src/routes/web";

const RESET = process.argv.includes("--reset");
// Base URL the ML service uses to fetch course-file URLs stored on the modules.
// Resolved inside the ML service, so it must be reachable from THERE, not from
// this script's host (see config/env.ts) — e.g. http://app:3000 when running
// this against a compose stack.
const APP_BASE_URL = env.internalBaseUrl;

async function main() {
  await mongoose.connect(env.mongodbUri);
  console.log("Connected to Mongo. Reading persisted curriculum...");

  const modules = await readPersistedCurriculumModules();
  console.log(`Loaded ${modules.length} module(s). Posting to ${SHAP_SERVICE_URL}/rag/reindex (reset=${RESET})...`);
  console.log("This makes real embedding API calls and may take a while.");

  const res = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/rag/reindex`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modules, baseUrl: APP_BASE_URL, reset: RESET })
  });

  if (!res.ok) {
    throw new Error(`/rag/reindex -> ${res.status} ${await res.text()}`);
  }

  const stats = await res.json();
  console.log("Reindex done:", stats);

  const statsRes = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/rag/stats`);
  if (statsRes.ok) {
    console.log("Store now holds:", await statsRes.json());
  }
}

main()
  .catch((error) => {
    console.error("Reindex failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
