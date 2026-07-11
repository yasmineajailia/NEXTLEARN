# SHAP explainer service

Serves **real** [`shap`](https://github.com/shap/shap) `TreeExplainer` values for
the **exact** production risk-prediction model, so the dashboard can explain *why*
a student is flagged based on the actual deployed Random Forest — not heuristics,
and not a re-trained approximation.

## How it fits in

- The production predictor is a JS `ml-random-forest` model (`data/rf-model.json`,
  trained by `scripts/train-model.ts`). `shap` can't read that format directly.
- `js_forest.py` **reconstructs the exact trees** from `data/rf-model.json` as an
  equivalent scikit-learn `RandomForestClassifier` (same splits, thresholds and
  leaves; leaves one-hot encoded to reproduce the JS forest's hard voting). No
  re-training, no separate dataset — SHAP explains the real model.
- `shap_service.py` builds an interventional `TreeExplainer(model_output="probability")`
  over it and serves `POST /explain`.
- The Node backend (`src/routes/web.ts`) calls this service and **falls back** to
  its in-process JS exact-Shapley implementation if the service is down.
  `explainSource` in the API response says which ran:
  `shap-python` (real shap, exact model) | `shap-js` (JS exact Shapley) | `rules`.

### Fidelity

The reconstructed trees are identical to production. The only residual difference
is a ~0.01 quirk in `ml-random-forest`'s `predictProbability` (its `reduce` has no
initial value, so one tree is aggregated slightly differently). Reconstruction was
verified against the live JS model on 200 random inputs: **max |Δ| = 0.0099**,
within that quirk bound. SHAP attributions are therefore faithful to the model's
actual decision structure.

## Setup

```bash
python -m pip install -r ml/requirements.txt   # or: npm run shap:install
npm run shap:serve                             # starts the service on :8000
```

No training step: the service loads `data/rf-model.json` directly. If you retrain
the JS model (`npm run train:model`), just restart the service.

Override the port with `SHAP_PORT`, and point Node at a different host with
`SHAP_SERVICE_URL` (default `http://127.0.0.1:8000`).

## Endpoints

- `GET /health` → `{ status, version, model, trees, features }`
- `POST /explain` body = the 7 features → `{ catchupProbability, baseValue, shapValues, riskFactors }`
  (SHAP values are additive in probability space: `baseValue + Σ shapValues = catchupProbability`).

## Files

- `js_forest.py` — reconstructs `data/rf-model.json` as an sklearn RandomForest.
- `shap_service.py` — FastAPI service exposing `shap.TreeExplainer`.
- `requirements.txt` — Python dependencies.
