"""
service_state.py

Singleton model/service state for shap_service.py's FastAPI app, split out so
the domain routers (ml/routers/*) can read the loaded models without
re-loading them and without a circular import against shap_service.py itself.

Everything below runs ONCE at import time: loading the joblib models, building
the SHAP background sample + TreeExplainers, and building the mastery
mastery estimator. These must stay true singletons (one RandomForest,
one SHAP background sample) shared by every request — do not
re-load them in a router module.
"""

import os

import numpy as np
import pandas as pd
import shap
from fastapi.responses import JSONResponse
from joblib import load

from mastery import estimator as mastery_estimator
from features import FEATURES

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RISK_MODEL_PATH = os.path.join(HERE, "models", "rf-risk.joblib")
GRADE_MODEL_PATH = os.path.join(HERE, "models", "rf-grade.joblib")
CSV_PATH = os.path.join(ROOT, "data", "student_analytics.csv")
BACKGROUND_SIZE = 100

# Features the model uses but that are never shown to a human as a "reason".
# hasAttentionData is a missingness flag: "you have no attention data" is not an
# actionable explanation, and its absence is neutral in the label by construction.
# Must mirror DISPLAY_EXCLUDED_FEATURES in features.ts.
DISPLAY_EXCLUDED = {"hasAttentionData"}
DISPLAY_FEATURES = [f for f in FEATURES if f not in DISPLAY_EXCLUDED]

# ---------------------------------------------------------------------------
# Load the native scikit-learn models + a training-data background sample, then
# build the SHAP TreeExplainers once at startup.
# ---------------------------------------------------------------------------
if not os.path.exists(RISK_MODEL_PATH):
    raise SystemExit(
        f"Missing {RISK_MODEL_PATH}. Train the models first: python ml/train.py"
    )

MODEL = load(RISK_MODEL_PATH)

_df = pd.read_csv(CSV_PATH)
_rng = np.random.default_rng(42)
_all = _df[FEATURES].astype(float).values
_idx = _rng.choice(len(_all), size=min(BACKGROUND_SIZE, len(_all)), replace=False)
BACKGROUND = _all[_idx]

EXPLAINER = shap.TreeExplainer(
    MODEL,
    data=BACKGROUND,
    feature_perturbation="interventional",
    model_output="probability",
)

GRADE_MODEL = None
GRADE_EXPLAINER = None
if os.path.exists(GRADE_MODEL_PATH):
    GRADE_MODEL = load(GRADE_MODEL_PATH)
    GRADE_EXPLAINER = shap.TreeExplainer(
        GRADE_MODEL,
        data=BACKGROUND,
        feature_perturbation="interventional",
    )

# Deterministic per-sous-acquis mastery estimator (no fitted model).
MASTERY_ESTIMATOR = mastery_estimator.MasteryEstimator()


def _class1_index() -> int:
    classes = list(getattr(MODEL, "classes_", [0, 1]))
    return classes.index(1) if 1 in classes else len(classes) - 1


C1 = _class1_index()


def predict_grade(x: np.ndarray) -> float | None:
    if GRADE_MODEL is None:
        return None
    g = float(GRADE_MODEL.predict(x)[0])
    return max(0.0, min(20.0, round(g * 10) / 10))


class UTF8JSONResponse(JSONResponse):
    """FastAPI's default JSONResponse encodes UTF-8 but ships `Content-Type:
    application/json` with NO charset. Spec-compliant clients (browsers, Node
    fetch) always decode JSON as UTF-8, but some do not — PowerShell's
    Invoke-WebRequest / `curl` default to ISO-8859-1 when no charset is given,
    which turns accented French (e.g. 'problème') into mojibake ('problÃ¨me').
    Advertising the charset makes every client decode correctly."""
    media_type = "application/json; charset=utf-8"
