# NextLearn

French e-learning platform for a C programming course (ESPRIT). Node.js/TypeScript/Express
backend, vanilla-JS frontend, MongoDB, with an ML layer (predictions + SHAP explanations),
a RAG chatbot, and browser-side attention tracking.

## Run

- `npm run dev` — tsx watch dev server on :3000 (loads both Random Forest models at boot).
  On boot it also auto-starts and supervises the Python SHAP service (see below) via
  `src/services/prediction/shapSupervisor.ts` — adopting an already-running one, else
  spawning `python ml/shap_service.py`, and restarting it with backoff if it dies.
- `npm run shap:serve` — runs the Python FastAPI SHAP service on :8000 (`ml/`) standalone.
  Not required in normal use (the dev server keeps it running); handy for debugging it in
  isolation. The in-process JS exact-Shapley → rule-based chain remains only as a crash
  guard for the brief (re)start windows. Override with `PYTHON_BIN` / `SHAP_PORT`.
- `npx tsc --noEmit` — typecheck (no test suite yet).
- Secrets live in `.env` (gitignored): MongoDB URI, OpenRouter key, SMTP. Never commit or print them.

## Layout

```
src/
  server.ts                 Express bootstrap; mounts every router; static /public
  config/env.ts             Env access
  models/                   Mongoose schemas (User holds progress + attentionSessions)
  routes/
    web.ts                  LEGACY MONOLITH (~4.3k lines): curriculum read/seed/persist
                            machinery, quizzes + self-eval, teacher quiz generation,
                            student dashboard/prediction/progress routes. Shrink it by
                            extracting domains into the pattern below — never grow it.
    auth.ts                 Sign-in/up, password reset (mounted inside webRouter)
    pages.ts                Static page routes (/sign-in, /backoffice, ...)
    student/                chatbot.ts (thin RAG proxy: access control + forwards
                            to Python), attentionSession.ts
    backoffice/             organization.ts (teachers/classes/students/access),
                            clustering.ts, attention.ts
  services/
    MLPredictorService.ts   Async client of the Python ML service (batch /predict);
                            no in-process model. predict/predictGrade/predictBatch
    prediction/features.ts  Feature vector (9 behavioral features), extractMLFeatures
                            (optionally module-scoped via moduleId). No JS model math
    prediction/explain.ts   Calls the Python service's POST /explain (prediction + SHAP);
                            Python-only, no JS fallback. Owns the shared circuit breaker
    prediction/shapSupervisor.ts  Auto-starts + supervises the Python ML service
    studentProgress.ts      Pure progress math (lesson keys, quiz averages)
    classAccess.ts          Module access rules + unlock schedules (data/calendar.txt),
                            overview filtering + student calendar entries
    chatbot/ragClient.ts    Sole RAG client: posts to the Python service
                            (/rag/answer, /rag/stream, /rag/reindex); history
                            normalization. No JS RAG engine anymore.
    courseContent.ts        GridFS + filesystem course files, PDF/DOCX/PPTX text
                            extraction (cached) for the RAG index
    textNormalize.ts        Shared text normalization utils
    curriculum.ts           moduleDocToOverview (seed of the future curriculum service)
    clustering/             kmeans.ts (feature engineering + normalization),
                            kmeansClient.ts (posts to Python /cluster), clusterLabeler.ts
    attention/attentionClient.ts  posts derived metrics to Python /attention-analytics
    quiz/quizGenClient.ts   posts to Python /generate-quiz (teacher quiz generation)
    recommendation/
  types/curriculum.ts       Shared ModuleOverview / ClassAccessContext shapes
ml/                         Python owns the ML + AI compute: train.py trains the two
                            native sklearn forests (rf-risk/rf-grade.joblib); quizgen.py
                            does LLM quiz generation; rag/ is the RAG index (ChromaDB store,
                            embeddings, doc extraction — Phase A); shap_service.py is the
                            FastAPI app (/predict /explain /cluster /attention-analytics
                            /generate-quiz /rag/reindex /rag/stats /rag/retrieve /rag/answer
                            /rag/stream)
scripts/                    Seeding, generate:training-data (writes student_analytics.csv),
                            resync:quizzes (model training is python ml/train.py)
public/
  student/, backoffice/, auth/, teacher/   Pages (vanilla JS)
  shared/theme.js|css       Dark + colour-blind modes (data-theme/data-cvd on <html>)
  shared/i18n.js            FR default inline, EN via data-i18n + I18N.t(); toggle persists
                            in localStorage nextlearnLang
  design-system/            Drop-in tokens/components/layouts/animations (see its README)
  dev/                      Dev-only test pages, not linked from the app
```

## Conventions & invariants

- **Commits**: never add Claude/AI attribution (enforced via settings `attribution`).
  Style: `feat: lowercase summary`.
- **No emojis in UI copy** — the owner explicitly wants the product not to look AI-generated.
- **i18n**: French is the source language and stays inline in markup; English lives in
  `shared/i18n.js` (+ per-page `I18N.extend`). New UI strings need `data-i18n` (markup) or
  `tr(key, frenchFallback)` (JS). Chatbot requests carry `lang`.
- **Auth (known weakness)**: students are identified by localStorage `nextlearnCurrentUser`,
  backoffice by `nextlearnCurrentTeacher` + `X-Teacher-Id` header. No sessions/JWT yet.
- **Attention tracking**: webcam frames + landmarks are processed only in the browser
  (MediaPipe); the server must only ever receive derived metrics. Consent gate is mandatory.
  The frame-scoring model CANNOT move server-side. Only the teacher-dashboard analytics over
  already-derived metrics (trend, top distraction) run in Python (`/attention-analytics`).
- **ML + AI run in Python only**: predictions, SHAP, K-means clustering, attention analytics
  and teacher quiz generation are all served by `ml/shap_service.py` (`/predict`, `/explain`,
  `/cluster`, `/attention-analytics`, `/generate-quiz`) — there is NO JS model or JS fallback.
  The Node server auto-starts and supervises it (`shapSupervisor.ts`); if Python can't run,
  these error rather than degrade. Node keeps feature engineering/normalization/labeling and
  just posts vectors. LLM keys (Gemini/OpenAI) reach Python via inherited env / `.env`
  (`ml/quizgen.py`). RAG chatbot is now Python-only: retrieval (ChromaDB) + scope guards +
  LLM generation live in `ml/rag/` (index/retrieve/guards/generate) behind `/rag/answer`,
  `/rag/stream`, `/rag/reindex`. Node's `chatbot.ts` is a thin proxy — it does access control
  and forwards to Python via `chatbot/ragClient.ts`; there is NO JS RAG engine or fallback
  (the old `chatbot/rag.ts` + `StudentChatbotVector` model were removed in Phase E). The Chroma
  store persists on disk (`ml/rag/chroma_store/`); populate/refresh it with `npm run
  reindex:rag`, and a curriculum save fires a background reindex. See `docs/rag-migration-plan.md`.
- **ML honesty**: report test/CV metrics only (risk ~0.70-0.71 acc, AUC ~0.79; grade
  MAE ~1.0 — native sklearn soft-voting). Training accuracy is meaningless here. Model
  changes: retrain with `python ml/train.py` (seed 42); it prints held-out + 5-fold
  metrics and rewrites `ml/models/*.joblib` + `data/model-features.json`.
- **SHAP fidelity**: the models are trained in sklearn, so `shap.TreeExplainer` reads
  them directly — no JS↔Python tree mirror to keep in sync. `shap_service.py` picks up
  new `ml/models/*.joblib` at start.
- **Quiz sources**: `data/*.normalized.json` are the source of truth; push into Mongo with
  `npm run resync:quizzes` (auto-backup; module 1 files 1.3/1.5/1.6 are known-malformed).
- Headless Chrome (`--headless --screenshot`) is the established way to verify UI changes;
  MediaPipe inference cannot run headless (no WebGL) — attention tracking needs a real browser.

## Refactoring direction

`src/routes/web.ts` is being decomposed incrementally. Extraction pattern: move pure
helpers into `src/services/`, shared shapes into `src/types/`, then lift the route block
into a focused router mounted in `server.ts`. Done so far: organization, pages, chatbot
(routes/student/chatbot.ts thin proxy + services/chatbot/ragClient.ts → Python `ml/rag/`).
Remaining candidates, largest first: curriculum read/seed/persist machinery (the
`readPersistedCurriculumModules` cluster — several extracted modules import it from
web.ts transitionally), teacher quiz generation, quiz submit/progress, student dashboard.
The frontend monoliths (`public/backoffice/backoffice.js` ~4.6k lines,
`public/student/student.js` ~2.5k) are the same story on the client side.
