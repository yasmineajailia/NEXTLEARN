# NextLearn

French e-learning platform for a C programming course (ESPRIT). Node.js/TypeScript/Express
backend, vanilla-JS frontend, MongoDB, with an ML layer (predictions + SHAP explanations),
a RAG chatbot, and browser-side attention tracking.

## Run

- `npm run dev` — tsx watch dev server on :3000 (loads both Random Forest models at boot).
- `npm run shap:serve` — optional Python FastAPI SHAP service on :8000 (`ml/`); without it
  the API falls back to the in-process JS exact-Shapley, then to rule-based explanations.
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
    student/                chatbot.ts (RAG routes + context orchestration + vector
                            warm-up), attentionSession.ts
    backoffice/             organization.ts (teachers/classes/students/access),
                            clustering.ts, attention.ts
  services/
    MLPredictorService.ts   Loads data/rf-model.json (risk) + rf-grade-model.json (grade /20)
    prediction/features.ts  Feature vector (7 behavioral features), exact JS Shapley,
                            extractMLFeatures (optionally module-scoped via moduleId)
    prediction/explain.ts   Explanation resolution: shap-python -> shap-js -> rules
                            (circuit breaker on the Python service)
    studentProgress.ts      Pure progress math (lesson keys, quiz averages)
    classAccess.ts          Module access rules + unlock schedules (data/calendar.txt),
                            overview filtering + student calendar entries
    chatbot/rag.ts          RAG engine: vector store (StudentChatbotVector), lexical
                            fallback, grounding checks, prompts, generate/stream.
                            Takes persisted modules as params — no curriculum reads.
    llm.ts                  Provider plumbing: embeddings, Gemini catalog, answer text
    courseContent.ts        GridFS + filesystem course files, PDF/DOCX/PPTX text
                            extraction (cached) for the RAG index
    textNormalize.ts        Shared text normalization utils
    curriculum.ts           moduleDocToOverview (seed of the future curriculum service)
    clustering/, recommendation/
  types/curriculum.ts       Shared ModuleOverview / ClassAccessContext shapes
ml/                         Python: js_forest.py reconstructs the EXACT deployed
                            ml-random-forest trees in sklearn; shap_service.py serves
                            TreeExplainer over them
scripts/                    Seeding, training (train:grade-model), evaluation
                            (evaluate:models, test:fresh-data), resync:quizzes
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
- **Attention tracking**: webcam frames are processed only in the browser (MediaPipe);
  the server must only ever receive derived metrics. Consent gate is mandatory.
- **ML honesty**: report test/CV metrics only (risk ~72-76% acc, AUC ~0.81-0.84; grade
  MAE ~0.95). Training accuracy is meaningless here. Model changes: retrain via scripts
  (seed 42) and re-run `evaluate:models` + `test:fresh-data`.
- **SHAP fidelity**: the Python service explains the exact deployed trees. If
  `data/rf-model.json` / `rf-grade-model.json` change, the service picks them up at start;
  keep `ml/js_forest.py` in sync with any ml-random-forest serialization changes.
- **Quiz sources**: `data/*.normalized.json` are the source of truth; push into Mongo with
  `npm run resync:quizzes` (auto-backup; module 1 files 1.3/1.5/1.6 are known-malformed).
- Headless Chrome (`--headless --screenshot`) is the established way to verify UI changes;
  MediaPipe inference cannot run headless (no WebGL) — attention tracking needs a real browser.

## Refactoring direction

`src/routes/web.ts` is being decomposed incrementally. Extraction pattern: move pure
helpers into `src/services/`, shared shapes into `src/types/`, then lift the route block
into a focused router mounted in `server.ts`. Done so far: organization, pages, chatbot
(routes/student/chatbot.ts + services/chatbot/rag.ts + llm.ts + courseContent.ts).
Remaining candidates, largest first: curriculum read/seed/persist machinery (the
`readPersistedCurriculumModules` cluster — several extracted modules import it from
web.ts transitionally), teacher quiz generation, quiz submit/progress, student dashboard.
The frontend monoliths (`public/backoffice/backoffice.js` ~4.6k lines,
`public/student/student.js` ~2.5k) are the same story on the client side.
