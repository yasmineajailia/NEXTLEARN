# ML service (predictions + SHAP)

The platform's whole data-science layer runs here. Two scikit-learn models are
**trained, served and explained natively in Python** — the Node backend owns no
ML model and computes no predictions itself; it posts feature vectors and reads
back numbers.

- `rf-risk.joblib`  — `RandomForestClassifier` → P(caughtUp), the catch-up risk gauge.
- `rf-grade.joblib` — `RandomForestRegressor`  → predicted exam grade /20.

Because the models are trained here in sklearn, `shap.TreeExplainer` reads them
directly — there is no JS↔Python tree reconstruction to keep in sync anymore.

## How it fits in

- `train.py` trains both models from `data/student_analytics.csv` (100 trees,
  max depth 10, seed 42), saves them to `ml/models/*.joblib`, and writes the
  feature list to `data/model-features.json`.
- `shap_service.py` loads those joblib models, builds an interventional
  `TreeExplainer(model_output="probability")` for risk and a `TreeExplainer` for
  grade, and serves `/predict` and `/explain`.
- The Node backend (`src/services/MLPredictorService.ts`, `prediction/explain.ts`)
  calls this service for **every** prediction and explanation. There is **no JS
  fallback** — the service is auto-started and supervised by
  `src/services/prediction/shapSupervisor.ts`, so if it can't run, predictions
  error rather than silently degrade.

## Setup

```bash
python -m pip install -r ml/requirements.txt   # or: npm run shap:install
python ml/train.py                             # or: npm run train:model  (trains + saves models)
```

`npm run dev` then auto-starts and supervises the service. To run it standalone:

```bash
npm run shap:serve                             # starts the service on :8000
```

Override the port with `SHAP_PORT`, point Node at a different host with
`SHAP_SERVICE_URL` (default `http://127.0.0.1:8000`), and the Python executable
with `PYTHON_BIN`.

## Endpoints

- `GET  /health`  → `{ status, library, shap, model, trees, gradeModel, features }`
- `POST /predict` body `{ instances: number[][] }` (rows in feature order) →
  `{ predictions: [{ catchupProbability, predictedGrade }] }` — fast path, no SHAP.
- `POST /explain` body = the feature object → `{ catchupProbability, predictedGrade,
  baseValue, shapValues, riskFactors, gradeShapValues, gradeFactors }`.
  Risk SHAP values are additive in probability space
  (`baseValue + Σ shapValues = catchupProbability`); grade SHAP values are in
  points /20.
- `POST /cluster` body `{ points: number[][], k }` → `{ assignments, centroids,
  iterations, converged }` — K-means (scikit-learn) for learning-profile segmentation.
- `POST /attention-analytics` body `{ students: [{ avgScores, distractions }] }` →
  `{ results: [{ trend, topDistraction }] }` — teacher-dashboard analytics over DERIVED
  attention metrics only (no frames/landmarks ever reach the server; frame scoring stays
  in the browser via MediaPipe).
- `POST /generate-quiz` body `{ moduleName, subAcquisName, difficulty, count, courseContent, ... }`
  → `{ questions: [{ prompt, options, correctOptionIndex, source }] }` — teacher quiz
  generation (`quizgen.py`): Gemini then OpenAI, with a template fallback. Needs the LLM
  keys in the environment (`GEMINI_API_KEY` / `OPENAI_API_KEY`); loaded from `.env` when
  run standalone, inherited from Node otherwise.

## Files

- `train.py` — trains the two sklearn models, saves joblib, prints honest test/CV metrics.
- `shap_service.py` — FastAPI service: predict + SHAP explain.
- `models/` — saved `rf-risk.joblib`, `rf-grade.joblib`.
- `requirements.txt` — Python dependencies.
