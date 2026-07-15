# How NextLearn works

A walkthrough of the whole system: what happens at boot, what happens when a student
clicks something, and how each of the four "intelligent" subsystems actually produces
its output. Written to be read top to bottom once, then dipped into later.

`CLAUDE.md` is the short version (conventions and invariants). This is the long version
(mechanisms). `README.md` is how to install and run it.

---

## 1. What the system is

A course delivery platform for the ESPRIT C-programming module, plus a layer of data
science on top of it.

The delivery half is ordinary: teachers upload course material, students read it, watch
videos, take quizzes, and progress. The interesting half is what the platform does with
the trail that activity leaves behind:

| Subsystem | Question it answers | Where it runs |
|---|---|---|
| Risk + grade prediction | Is this student heading for the catch-up exam, and what grade are they heading toward? | Server, in-process |
| SHAP explanations | *Why* does the model think that? | Python service, with two fallbacks |
| RAG chatbot | Answer a course question using only the real course material | Server + LLM API |
| Clustering / recommendation | What kind of learner is this, and what should they do next? | Server |
| Attention tracking | Is the student actually focused while studying? | **Browser only** |

Everything is a single Express app. There is no separate frontend build: `public/` is
served statically and the pages are hand-written HTML with vanilla JavaScript.

### Every model in the project, in one table

Worth being precise about this, because the project mixes models we trained ourselves with
pretrained ones we merely call — and in a defence you will be asked which is which.

| Model | What it does | Ours or third-party? | Where |
|---|---|---|---|
| **Random Forest classifier** | Probability the student catches up (the inverse of risk) | **Trained by us** (`npm run train:model`, seed 42), 9 features: 7 behavioural + attention (score + missingness indicator) | `data/rf-model.json`, loaded in-process at boot |
| **Random Forest regressor** | Predicted exam grade out of 20 | **Trained by us** (`npm run train:grade-model`), same 9 features | `data/rf-grade-model.json`, in-process |
| **SHAP TreeExplainer** | Explains the two forests above | Third-party library (`shap`), *not* a model — an explainer over our exact trees | `ml/shap_service.py` (FastAPI), with an exact-Shapley JS fallback |
| **K-means** | Groups a class into learner profiles | **Ours**, hand-written; fitted on demand, nothing persisted | `src/services/clustering/kmeans.ts` |
| **MediaPipe FaceMesh** | 478 facial landmarks for the focus score | **Third-party, pretrained** — we never train or fine-tune it | Loaded from CDN, runs **in the browser only** |
| **Embedding model** | Vectorises course text and questions for the RAG chatbot | Third-party API (OpenAI/OpenRouter, e.g. `text-embedding-3-small`) | Called from `src/services/llm.ts`, vectors cached in Mongo |
| **Chat LLM** | Writes the chatbot's answer from retrieved course chunks | Third-party API (OpenRouter, e.g. Llama 3.3 70B; Gemini also supported) | `src/services/llm.ts` |

Two things are deliberately **not** models, despite looking like they should be: the VARK
learning profile is a deterministic score over the mini-games, and the "what should I study
next" recommender is prerequisite-graph arithmetic over `graph.json`. Neither learns
anything.

---

## 2. Boot sequence

`src/server.ts` is the whole bootstrap, and it is short enough to read in one sitting.

1. `express.json({ limit: "25mb" })` — the limit is high because course files are
   uploaded through JSON payloads.
2. Static mounts:
   - `public/` at `/` (all pages, CSS, client JS)
   - `content/Support_Cours_Préparation/` — the course files on disk
   - `/graph.json` — the prerequisite graph, served from the repo root
   - `/vendor/pdfjs` — mapped straight into `node_modules/pdfjs-dist/build`, so the
     PDF viewer is served without a bundler
3. Routers, in order: `webRouter`, `chatbotRouter`, `pagesRouter`, `organizationRouter`,
   `clusteringRouter`, `attentionRouter`, `attentionSessionRouter`.
4. A JSON 404 fallback.
5. Then `startServer()`: connect to MongoDB, and kick off two background jobs that
   **do not block startup**:
   - `MLPredictorService.initialize()` — loads both Random Forests from disk
   - `warmStudentVectorStore()` — builds the chatbot's vector index

Those last two are deliberately fire-and-forget. The server answers requests while the
models load; a prediction requested in that window falls back gracefully (see §6.3).

---

## 3. The domain model

Three ideas carry the whole application.

### The curriculum is a three-level tree

```
Module            "Programmation en C"
└── Acquis        a competency block
    └── Sous-acquis   the actual unit of study
        ├── course material (PDF)
        ├── videos
        └── one quiz
```

**The sous-acquis is the atom of the system.** Progress, quizzes, predictions, unlocking,
attention sessions — everything is keyed to a sous-acquis. Stored in the
`CurriculumModule` collection (`src/models/CurriculumModule.ts`), where a module document
embeds its acquis, which embed their sous-acquis, which embed their quiz questions.

### A student is a User with a progress blob

`src/models/User.ts`. Beyond credentials, everything lives under `progress`:

- `xp` — a running total
- `completedLessonKeys` — array of `"moduleId::subAcquisId"` style keys
- `quizResults[]` — `{ lessonKey, moduleId, subAcquisId, score, attempts, submittedAt }`
- `selfEvaluationResults[]`
- `attentionSessions[]` — derived focus metrics (never images)

This one document is the input to nearly every computation downstream. The prediction
features, the clustering vector, and the dashboard are all just different projections
of this blob.

### Classes gate access

`ClassRoom` + `src/services/classAccess.ts`. A teacher puts students in a class and
decides which modules that class can see, on a weekly unlock schedule anchored to a start
date (`data/calendar.txt`). So two students on the same platform can legitimately see
different amounts of the course. This matters later: "how far behind is this student"
is measured against *their class schedule*, not against the calendar year.

---

## 4. What happens when a student uses it

### Signing in

`src/routes/auth.ts` — `POST /api/sign-in` checks the password and returns the user.
The browser stores the result in `localStorage` under `nextlearnCurrentUser`.

**There are no sessions and no JWT.** Every subsequent request identifies the student by
passing their identifier, and the backoffice by sending an `X-Teacher-Id` header. This is
the single biggest known weakness in the system — see §9.

Password reset is real, though: a random token is generated, only its SHA-256 hash is
stored (`passwordResetTokenHash` + an expiry), and the raw token goes out by email.

### The dashboard

`public/student/index.html` + `student.js`. On load it fetches the student's progress and
renders: the hero summary (identity, XP, streak, progress, key stats), the AI prediction
card, the next step, quiz-score trend, overall progress ring, weakest modules, per-module
progress, a weekly activity heatmap, deadlines, achievements, and the Learner Mission
banner.

### A lesson

`public/student/sous-acquis.html` renders the PDF (via pdf.js), the videos, and hosts the
chatbot launcher. It also reads the student's VARK profile from `localStorage` and shows a
recommendation banner tuned to their dominant learning style.

### A quiz

`public/student/questionnaire.html`, submitted back to `web.ts`. The rules, from the code:

- **`QUIZ_MAX_ATTEMPTS = 2`** — two tries per quiz
- **`QUIZ_PASS_SCORE = 60`** — 60% or better validates the sous-acquis
- A quiz is settled when the student passes, or when both attempts are used
- Passing marks the sous-acquis complete, awards XP, and can unlock what comes next

Self-evaluation is a parallel track with the same 60% pass mark
(`SELF_EVALUATION_PASS_SCORE`).

---

## 5. Progress, honestly computed

`src/services/studentProgress.ts` is pure math, no database calls: lesson keys, per-module
quiz averages, overall progress. It is deliberately pure so the same numbers can be
computed in a route, in a script, or in a test without a Mongo connection.

One subtlety worth knowing: the denominator (how many sous-acquis exist in total) is
resolved from the database at request time by `resolveTotalSubAcquisCount()` in `web.ts`,
cached with a TTL. It is not hard-coded — except in the clustering service, which does
hard-code it (§9).

---

## 6. Prediction: the part that makes this a data-science project

### 6.1 The feature vector

`src/services/prediction/features.ts` is the single source of truth, shared by the API,
the ML service, and the training scripts, precisely so training and inference can never
drift apart. Seven behavioural features, in a fixed order:

| Feature | Meaning | Range |
|---|---|---|
| `delayWeeks` | How many weeks behind the expected pace (2 sous-acquis/week), measured against the class schedule when there is one, otherwise account age | 0–12 |
| `completionPace` | Sous-acquis completed per week | 0–5 |
| `averageScore` | Mean quiz score (defaults to 50 when there are none) | 0–100 |
| `loginFrequency` | Logins per week | 0–14 |
| `gapDepth` | Fraction of the curriculum still untouched | 0–1 |
| `recencyRatio` | 1.0 = active today, 0 = dormant for 28+ days | 0–1 |
| `weakSkillRatio` | Fraction of quizzes scored below 60 | 0–1 |

Every value is clamped to its range and the whole function is NaN- and
divide-by-zero-safe. Note there is **no demographic data anywhere** — the model only ever
sees behaviour.

### 6.2 The two models

`src/services/MLPredictorService.ts` loads two pre-trained Random Forests from disk at
boot (they are committed as JSON, not trained at runtime):

- `data/rf-model.json` — **classifier**. Outputs the probability that the student catches
  up, i.e. the *inverse* of risk. Higher is better.
- `data/rf-grade-model.json` — **regressor**. Outputs the predicted exam grade out of 20.

Both are Random Forests of **100 trees, max depth 10, seed 42** (`scripts/train-model.ts`),
built with the `ml-random-forest` JavaScript library. Training happens offline through the
scripts and the resulting forest is committed as JSON; the server only ever *loads* it, so
predictions are deterministic and cost well under 100 ms in-process.

Predictions can be scoped to a single module (`extractMLFeatures` takes an optional
`moduleId`), which is why the dashboard's prediction card has a module dropdown.

### 6.3 The explanation chain — the nicest piece of engineering in the project

A prediction nobody can explain is useless to a teacher, so every prediction ships with
its attributions. `src/services/prediction/explain.ts` resolves them through a
**three-level fallback**:

1. **`shap-python`** — POST the feature vector to the FastAPI service on `:8000`
   (`ml/shap_service.py`). This is the real `shap` library running `TreeExplainer` over
   trees reconstructed *exactly* from the deployed JSON forest (`ml/js_forest.py`). This
   is the only path that gives true SHAP values.
2. **`shap-js`** — if the Python service is unreachable, compute **exact Shapley values in
   JavaScript** in-process. Exact, not approximate: with 7 features, enumerating coalitions
   is cheap.
3. **`rules`** — if the models themselves are not loaded, fall back to hand-written
   heuristics ("logs in less than once a week" and so on).

The response always carries an `explainSource` field naming which path produced it, so you
are never guessing about the provenance of an explanation.

A **circuit breaker** guards level 1: a 2.5s timeout, and on failure the Python service is
marked down for 30 seconds (`shapServiceDownUntil`) so that every subsequent request skips
straight to level 2 instead of each paying the timeout.

The upshot: **the SHAP service is optional**. Without it the app degrades quietly rather
than breaking, which is why `npm run shap:serve` is not part of `npm run dev`.

---

## 7. The other three subsystems

### 7.1 RAG chatbot

`src/services/chatbot/rag.ts` (the engine) and `src/routes/student/chatbot.ts` (the
routes). The engine is deliberately pure with respect to the database: it takes the
persisted modules as a *parameter* and never reads the curriculum itself.

The pipeline:

1. **Index** — `src/services/courseContent.ts` pulls the real course files (from GridFS or
   disk) and extracts text from PDF, DOCX and PPTX, with caching. Those become chunks.
2. **Embed and store** — chunks are embedded and cached in the `StudentChatbotVector`
   collection, so the expensive step happens once. `warmStudentVectorStore()` does this at
   boot.
3. **Retrieve** — cosine similarity over the vectors, with a **lexical fallback** if
   embeddings are unavailable (no API key, provider down). The chatbot still works
   degraded rather than not at all.
4. **Guard** — before answering: is this question even about C? (`isQuestionOutsideLangageC`)
   Is it too vague to answer? Is there meaningful grounding in the retrieved chunks?
5. **Generate** — the LLM answers with the chunks as context (`src/services/llm.ts` handles
   the providers). Streams over SSE.
6. **Verify** — `isAnswerGroundedInChunks()` checks the generated answer against the
   retrieved material. **An answer that is not grounded is thrown away** and replaced by a
   deterministic answer built directly from the chunks.

That last step is the whole point: the assistant is designed to be unable to confidently
invent C facts that are not in the course.

Requests carry a `lang` field so the assistant replies in the interface language.

### 7.2 Learning profiles, two different mechanisms

These are easy to confuse because both are "personalisation", but they are unrelated:

**K-means clustering (teacher-facing).** `src/services/clustering/kmeans.ts` builds a
six-feature vector per student — `completionRate`, `avgQuizScore`, `quizAttemptRate`,
`weeklyLoginFrequency`, `progressVelocity`, `weakSkillRatio` — normalises it, clusters the
class, and `clusterLabeler.ts` turns each cluster into a label a human can act on. Shown in
the backoffice.

**VARK (student-facing).** `public/student/mission-apprenant.html` — eight mini-games (two
per dimension: Visual, Read/write, Auditory-sequential, Kinesthetic) that never name the
dimension being tested. The result is written to `localStorage` under
`nextlearn_vark_result`, and lesson pages read it to decide which resource to recommend
first (videos for visual learners, PDFs for readers, the chatbot for the sequential
profile, quizzes-first for the kinesthetic).

**The prerequisite graph (a third thing again).** `graph.json` at the repo root maps each
chapter to what it unlocks. `src/services/recommendation/skill-recommender.ts` scores which
sous-acquis a student is *ready* for — prerequisites met, and how much completing it would
unlock. This is why `graph.json` is served as a route and must not be deleted.

(Minor inconsistency to be aware of: its metadata declares `total_chapters: 46`, but the
file actually contains 39 `sub_skills` nodes.)

### 7.3 Attention tracking and the focus score

All of this lives in one file: `public/student/js/attentionTracker.js` (~800 lines). It is
the only computer vision in the project, and the only place a model runs in the browser.

#### The model

**MediaPipe FaceMesh**, loaded from a CDN at runtime (`@mediapipe/face_mesh` +
`camera_utils`). It is a **pretrained, off-the-shelf model** — we do not train it, fine-tune
it, or ship weights for it. It is a convolutional face-landmark network from Google that
takes a video frame and returns a dense mesh of facial points.

It is configured (`faceMesh.setOptions`) as:

```js
maxNumFaces: 1,
refineLandmarks: true,        // adds the iris landmarks — required for gaze
minDetectionConfidence: 0.5,
minTrackingConfidence: 0.5
```

`refineLandmarks: true` is what raises the mesh from 468 to **478 landmarks**: the extra ten
are the two irises (468–472 left, 473–477 right). Without them gaze cannot be computed, and
the code degrades gracefully — `computeGazeShift()` returns `null` and the gaze check is
simply skipped rather than failing the frame.

Note what this model does *not* do: no identification, no emotion recognition, no
demographic inference. It returns geometry, and everything below is ordinary arithmetic on
that geometry. There is no second model and no classifier — the focus score is a
deterministic formula, not a prediction.

#### Three checks per frame

The camera runs at 640×480 and frames are throttled to **8 fps** (`FRAME_INTERVAL_MS = 125`
— anything faster is wasted work for a metric averaged over 30 seconds). For each processed
frame, three independent checks run on the landmark geometry. A frame counts as **focused only if all of
them pass** (and a face is present at all — no face is its own failure, `reason: "no_face"`).

**1. Eyes open — Eye Aspect Ratio (EAR).** For each eye, the vertical opening is divided by
the horizontal width:

```
EAR_left  = dist(159, 145) / dist(33, 133)
EAR_right = dist(386, 374) / dist(362, 263)
EAR       = (EAR_left + EAR_right) / 2
```

An open eye is tall relative to its width, so EAR falls as the lid closes. Below
`EAR_THRESHOLD = 0.2` the eye is considered shut — **but only if it stays shut for more than
`EYES_CLOSED_MS = 2000`**. That debounce is deliberate: a blink lasts ~100–300 ms and must
not cost the student a point. The timer resets the moment EAR climbs back above the
threshold.

**2. Head facing forward — yaw ratio.** Using the nose tip (landmark 1) and the two cheek
edges (234 and 454):

```
yaw = |nose.x - cheekLeft.x| / |nose.x - cheekRight.x|
```

Facing the screen puts the nose midway between the cheeks, so the ratio sits near **1.0**.
Turning the head shortens one side and lengthens the other. Outside the band
`[YAW_LOW = 0.65, YAW_HIGH = 1.35]` — roughly ±35% asymmetry — the head counts as turned
away. This is a ratio of two distances in the same frame, so it is naturally scale-invariant:
sitting closer to or further from the camera does not change it.

**3. Gaze on screen — iris offset.** The five landmarks of each iris are averaged to get its
centre, which is then located between that eye's two corners:

```
ratio = (irisCentre.x - eyeInner.x) / (eyeOuter.x - eyeInner.x)   // 0..1 across the eye
shift = |ratio - 0.5| * 2                                         // 0 = centred, 1 = at a corner
```

Averaged over both eyes. Above `GAZE_SHIFT_LIMIT = 0.4` — the iris more than 40% of the way
toward a corner — the student is looking away. This catches the case the head-pose check
misses: a face pointed straight at the screen while the eyes are off reading a phone.

#### The lighting guard (a skip, not a penalty)

Every 10th processed frame, average luminance is computed from a 16×16 downscale of the
frame using the Rec. 601 weighting `0.299R + 0.587G + 0.114B`. If it falls below
`BRIGHTNESS_MIN = 40` (of 255), the frame is **discarded entirely** — it enters neither the
focused nor the distracted count, and the student is warned once that the lighting is too
poor for reliable tracking.

This is a deliberate design decision, and the right one: in a dark room the landmarks are
unreliable, so the honest response is to record nothing rather than to punish a student for
their lighting.

#### From frames to a score

Focused/not-focused frames are pushed into a **rolling 30-second window**
(`WINDOW_MS = 30000`), and every **5 seconds** (`SCORE_INTERVAL_MS = 5000`) a sample is
taken:

```
score = round(focused frames in window / total frames in window × 100)
```

So the focus score is simply **the percentage of the last 30 seconds you were attentive**,
refreshed every 5 seconds. That number drives the ring widget on the lesson page and is
emitted as a `nextlearn:focusUpdate` DOM event that any page can listen to.

**The clock only runs while you are actually studying.** The window is indexed by *active*
session time (`activeMs()`), not wall-clock time. Tracking pauses on `visibilitychange`
(switching tabs) and on a manual toggle, and the accumulated-time clock freezes with it — so
time spent away from the tab is not counted as distraction. One nice detail: a pause the
*user* asked for is not silently undone when the tab becomes visible again.

**Distraction events** are the complement: each unbroken run of unfocused frames is recorded
as `{ t, reason, duration }`, where `reason` is one of `no_face`, `eyes_closed`,
`head_turned` or `gaze_away`. If distraction persists past 5 seconds the widget pulses and a
gentle nudge appears (at most one per 30 seconds).

#### The session summary

When the session stops, the browser sends **one** POST to `/api/student/attention-session`:

```
identifier, sessionId, context ("lesson" | "quiz"), moduleId, subAcquisId,
duration          // active seconds, excluding pauses
avgFocusScore     // mean of all 5s samples
minFocusScore     // the worst sample — since each sample IS a 30s-window score,
                  // this is literally the worst 30-second stretch of the session
distractionEvents // [{ t, reason, duration }]
focusTimeline     // every sample: [{ t, score }]
completedAt
```

The server (`src/routes/student/attentionSession.ts`) validates and sanitises this, appends
it to `user.progress.attentionSessions`, and recomputes `progress.avgFocusScore` as a
**rolling average over the student's last `ROLLING_WINDOW = 10` sessions**. The teacher's
class view (`src/routes/backoffice/attention.ts`) aggregates from there: class average, the
most common distraction reason, and students sorted by focus with unmeasured students last.

#### The hard rule, and one honest caveat

**No frame, image, or video ever leaves the browser.** There is exactly one `fetch` in the
entire tracker and it sends the numeric object above. The 16×16 canvas exists only to
average brightness locally. The consent gate (stored under `nextlearn_attention_consent`) is
mandatory. If you change this file, that invariant is the thing to protect.

**The focus score IS now an input to the risk and grade models — with caveats you must be
able to state.** It enters as a *pair* of features: `avgFocusScore` (0–100) and
`hasAttentionData` (0/1). Two things make this honest rather than decorative:

1. **Missing data is never imputed.** Attention is consent-gated, so most students have none
   (2 of 35 at the time of writing). A student with no sessions gets `avgFocusScore = 0` AND
   `hasAttentionData = 0`, and the forest learns from the indicator to ignore the score in
   that case. The synthetic label is built so that having no attention data is *exactly*
   neutral — never consenting to the webcam can neither help nor hurt a prediction. That
   neutrality is a design promise; preserve it if you touch the weights.
2. **The relationship is asserted, not learned.** There are no real end-of-term outcomes, so
   the link between focus and catching up cannot be discovered from data. It is written down
   in `scripts/lib/syntheticLabel.ts` (focus = 15% of the latent success score, below quiz
   average at 24% and recency at 20%), and the forest reproduces what we wrote. Any accuracy
   figure therefore measures "can the model recover the relationship we asserted", not "does
   focus predict real exams". Say this plainly if asked.

Run `npx tsx scripts/ablate-attention.ts` for the honest before/after: it retrains with and
without the two attention columns on identical splits.

The clustering vector (six features) still contains no attention data.

---

## 8. The teacher side

`src/routes/backoffice/`:

- **`organization.ts`** — teachers, classes, students, and module access (the biggest one)
- **`clustering.ts`** — the learning-profile dashboard
- **`attention.ts`** — class concentration

Plus, still inside `web.ts`: AI quiz generation, and the curriculum read/seed/persist
machinery.

Teachers are a separate collection (`Teacher`) and are identified by the `X-Teacher-Id`
header.

---

## 9. Sharp edges — read this before changing things

These are real, and knowing them will save you an afternoon.

**Authentication is not real.** `localStorage` holds the current user; the server trusts
the identifier it is given. Anyone can call the API as anyone. This is fine for a graded
project demo and is not fine for anything else. Fixing it means adding sessions or JWTs and
a middleware that resolves the caller from a token instead of from the request body.

**`src/routes/web.ts` is a 4.3k-line monolith.** It is being decomposed incrementally, and
the pattern is documented in `CLAUDE.md`: pure helpers to `src/services/`, shared types to
`src/types/`, then lift the route block into a focused router. Already extracted:
organization, pages, chatbot, prediction, class access, progress. Still inside: curriculum
read/seed/persist, teacher quiz generation, quiz submit, student dashboard. **Never grow
this file.** The same story applies on the client (`backoffice.js` ~4.6k lines,
`student.js` ~2.5k).

**Two different totals for "how many sous-acquis exist".** The prediction path resolves it
from the database (`resolveTotalSubAcquisCount()`); the clustering service hard-codes
`TOTAL_SUB_ACQUIS = 84` in `kmeans.ts`. If the curriculum changes size, clustering silently
uses a stale denominator. Worth reconciling.

**`catchupProbability` is a success probability, not a risk.** It is the probability the
student *catches up*, so **higher is better** — the student dashboard prints it as
"% de réussite". Risk is its complement, `1 - catchupProbability`. Getting this backwards
is not hypothetical: the back-office "Étudiants à risque" list did exactly that, ranking
the strongest students as the most at risk while the failing ones (0% catch-up) never
appeared at all. Whenever you consume this field, ask yourself which direction is bad.

**A zero feature can mean "no data", not "good".** `weakSkillRatio` is 0 for a student who
has failed nothing *and* for a student who has never taken a quiz; `averageScore` defaults
to 50 for a student with no scores at all. Any UI that reads these raw will call a student
who never logged in "low risk". The clustering risk badge now checks for the absence of
evidence first and labels such a student "Inactif" or "Sans évaluation" instead.

**ML metric honesty.** Report test/CV numbers only: risk accuracy ~72–76%, AUC ~0.81–0.84;
grade MAE ~0.95 points out of 20. Training accuracy (~99%) is meaningless here because the
labels carry deliberate noise, and quoting it would be dishonest. Retrain with the scripts
(seed 42) and re-run `evaluate:models` and `test:fresh-data`.

**SHAP fidelity.** `ml/js_forest.py` reconstructs the deployed trees exactly. If you change
how `ml-random-forest` serialises a model, that file must change with it or the
explanations stop describing the model that is actually running.

**Quiz sources.** `data/*.normalized.json` is the source of truth; push it into Mongo with
`npm run resync:quizzes` (it takes a backup first). Module 1 files 1.3, 1.5 and 1.6 are
known to be malformed.

**There is no test suite.** `npx tsc --noEmit` is the only automated check. UI changes are
verified with headless Chrome — except attention tracking, which needs a real browser
because MediaPipe cannot get WebGL in headless.

---

## 10. Where to look for what

```
src/
  server.ts                    boot, static mounts, router wiring
  config/env.ts                every environment variable
  models/                      Mongoose schemas (User holds all progress)
  routes/
    web.ts                     the monolith: curriculum, quizzes, dashboard
    auth.ts                    sign-in/up, password reset
    pages.ts                   static page routes
    student/                   chatbot, attention sessions
    backoffice/                organization, clustering, attention
  services/
    MLPredictorService.ts      loads both forests
    prediction/features.ts     the 7 features + exact JS Shapley
    prediction/explain.ts      the 3-level explanation fallback
    chatbot/rag.ts             the RAG engine
    llm.ts                     provider plumbing (embeddings, chat)
    courseContent.ts           GridFS + PDF/DOCX/PPTX text extraction
    classAccess.ts             who can see which module, and when
    studentProgress.ts         pure progress math
    clustering/, recommendation/
ml/                            Python: exact tree reconstruction + SHAP service
scripts/                       seed, train, evaluate
data/                          trained models, normalized quizzes, calendar
graph.json                     prerequisite graph (SERVED AS A ROUTE — do not delete)
public/
  student/, backoffice/, auth/ the pages
  shared/theme.js|css          dark mode + colour-blind palette
  shared/i18n.js               FR inline, EN in the dictionary
  design-system/               drop-in tokens/components/layouts
  dev/                         dev-only test pages, not linked from the app
```

---

## 11. Cross-cutting conventions

**Language.** French is the source language and lives inline in the markup. English lives
in `public/shared/i18n.js` and is resolved through `data-i18n` attributes in HTML or
`tr(key, frenchFallback)` in JavaScript. An unknown key falls back to French, so a missing
translation degrades to French rather than to a blank. The toggle persists in `localStorage`
under `nextlearnLang` and reloads the page so JS-rendered strings re-render.

Two traps, both already hit once: a dynamic value slot must not carry a `data-i18n`
attribute (a later translation pass will overwrite the value — this is what once replaced
the student's name with the literal text "Student name"), and JS-rendered UI cannot be
translated by attributes at all, so it has to call `tr()` at every call site.

**Theming.** `data-theme` and `data-cvd` on `<html>`, set before first paint to avoid a
flash. Dark mode and a colour-blind-safe palette.

**No emojis in UI copy**, and no AI attribution in commits. Both are deliberate: the owner
does not want the product to read as machine-generated. (The Learner Mission game is the
one exception, and its emoji are part of its own playful design.)
