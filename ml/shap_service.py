"""
shap_service.py

FastAPI microservice that serves REAL SHAP explanations for the student
risk-prediction model using the industry-standard `shap` library
(shap.TreeExplainer over the scikit-learn mirror model).

Interventional feature perturbation + model_output="probability" means the
returned SHAP values are in PROBABILITY POINTS and are additive:
    predict_proba(x)[caughtUp] = base_value + sum(shap_values)

Run:  python ml/shap_service.py         (defaults to 127.0.0.1:8000)
      SHAP_PORT=8000 python ml/shap_service.py

The Node backend calls POST /explain and falls back to its own exact-Shapley
JS implementation if this service is unavailable.
"""

import os

import numpy as np
import pandas as pd
import shap
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

from js_forest import load_js_forest, load_js_regression_forest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODEL_PATH = os.path.join(ROOT, "data", "rf-model.json")
GRADE_MODEL_PATH = os.path.join(ROOT, "data", "rf-grade-model.json")
CSV_PATH = os.path.join(ROOT, "data", "student_analytics.csv")
BACKGROUND_SIZE = 100

FEATURES = [
    "delayWeeks",
    "completionPace",
    "averageScore",
    "loginFrequency",
    "gapDepth",
    "recencyRatio",
    "weakSkillRatio",
]

# ---------------------------------------------------------------------------
# Load the EXACT production ml-random-forest model (reconstructed as sklearn so
# shap can read it) + a training-data background sample, then build the SHAP
# TreeExplainer once at startup.
# ---------------------------------------------------------------------------
MODEL = load_js_forest(MODEL_PATH)

_df = pd.read_csv(CSV_PATH)
_rng = np.random.default_rng(42)
_all = _df[FEATURES].astype(float).values
_idx = _rng.choice(len(_all), size=min(BACKGROUND_SIZE, len(_all)), replace=False)
BACKGROUND = _all[_idx]

# Interventional + probability output => SHAP values in probability points,
# additive to predict_proba. This is the canonical setup for explaining a
# classifier's probability with the real shap library.
EXPLAINER = shap.TreeExplainer(
    MODEL,
    data=BACKGROUND,
    feature_perturbation="interventional",
    model_output="probability",
)

# Grade regression explainer (optional — absent until the grade model is trained).
# SHAP values here are in GRADE POINTS (/20), additive to the predicted grade.
GRADE_MODEL = None
GRADE_EXPLAINER = None
if os.path.exists(GRADE_MODEL_PATH):
    GRADE_MODEL = load_js_regression_forest(GRADE_MODEL_PATH)
    GRADE_EXPLAINER = shap.TreeExplainer(
        GRADE_MODEL,
        data=BACKGROUND,
        feature_perturbation="interventional",
    )


def _class1_index() -> int:
    classes = list(getattr(MODEL, "classes_", [0, 1]))
    return classes.index(1) if 1 in classes else len(classes) - 1


C1 = _class1_index()


def shap_factor_label(key: str, f: dict, positive: bool) -> str:
    """French label for a factor — phrased as a risk when negative, protective when positive."""
    if key == "delayWeeks":
        n = round(f["delayWeeks"])
        return "Bonne avance sur le planning" if positive else f"Retard d'environ {n} semaine{'s' if f['delayWeeks'] >= 2 else ''}"
    if key == "averageScore":
        s = round(f["averageScore"])
        return f"Bons scores aux quiz ({s}%)" if positive else f"Score moyen faible ({s}%)"
    if key == "recencyRatio":
        if positive:
            return "Activité régulière et récente"
        return "Aucune activité récente" if f["recencyRatio"] <= 0 else "Peu d'activité récente"
    if key == "weakSkillRatio":
        return "Peu de quiz en difficulté" if positive else f"{round(f['weakSkillRatio']*100)}% de quiz en difficulté"
    if key == "gapDepth":
        return "Bonne progression dans le programme" if positive else f"{round(f['gapDepth']*100)}% du programme non commencé"
    if key == "loginFrequency":
        return "Connexions fréquentes" if positive else "Connexions rares"
    if key == "completionPace":
        return f"Bon rythme ({f['completionPace']:.1f}/sem)" if positive else f"Rythme lent ({f['completionPace']:.1f}/sem)"
    return key


def build_risk_factors(feat: dict, shap_by_feature: dict) -> list:
    entries = [{"key": k, "value": float(shap_by_feature[k])} for k in FEATURES]
    drivers = sorted([e for e in entries if e["value"] <= -0.02], key=lambda e: e["value"])
    if drivers:
        out = []
        for d in drivers[:3]:
            out.append({
                "feature": d["key"],
                "label": shap_factor_label(d["key"], feat, positive=False),
                "level": "high" if d["value"] <= -0.15 else "medium",
                "impact": d["value"],
            })
        return out
    protectors = sorted([e for e in entries if e["value"] >= 0.03], key=lambda e: -e["value"])
    if protectors:
        p = protectors[0]
        return [{
            "feature": p["key"],
            "label": shap_factor_label(p["key"], feat, positive=True),
            "level": "good",
            "impact": p["value"],
        }]
    return [{"label": "Progression saine, aucun signal de risque", "level": "good"}]


def build_grade_factors(feat: dict, shap_by_feature: dict) -> list:
    """Top grade drivers, thresholds in grade points (/20)."""
    entries = [{"key": k, "value": float(shap_by_feature[k])} for k in FEATURES]
    drivers = sorted([e for e in entries if e["value"] <= -0.5], key=lambda e: e["value"])
    if drivers:
        return [{
            "feature": d["key"],
            "label": shap_factor_label(d["key"], feat, positive=False),
            "level": "high" if d["value"] <= -2.0 else "medium",
            "impact": d["value"],
        } for d in drivers[:3]]
    protectors = sorted([e for e in entries if e["value"] >= 0.5], key=lambda e: -e["value"])
    if protectors:
        p = protectors[0]
        return [{
            "feature": p["key"],
            "label": shap_factor_label(p["key"], feat, positive=True),
            "level": "good",
            "impact": p["value"],
        }]
    return []


class Features(BaseModel):
    delayWeeks: float
    completionPace: float
    averageScore: float
    loginFrequency: float
    gapDepth: float
    recencyRatio: float
    weakSkillRatio: float


app = FastAPI(title="NextLearn SHAP explainer", version="1.0")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "library": "shap",
        "version": shap.__version__,
        "model": "ml-random-forest (exact, reconstructed)",
        "trees": len(MODEL.estimators_),
        "gradeModel": GRADE_MODEL is not None,
        "features": FEATURES,
    }


@app.post("/explain")
def explain(body: Features):
    feat = body.model_dump()
    x = np.array([[feat[k] for k in FEATURES]], dtype=float)

    # SHAP values (probability space). Handle both ndarray and per-class list outputs.
    raw = EXPLAINER.shap_values(x, check_additivity=False)
    if isinstance(raw, list):
        vals = np.asarray(raw[C1])[0]
    else:
        arr = np.asarray(raw)
        vals = arr[0, :, C1] if arr.ndim == 3 else arr[0]

    base = EXPLAINER.expected_value
    base_value = float(np.ravel(base)[C1]) if np.ndim(base) > 0 else float(base)

    prob = float(MODEL.predict_proba(x)[0][C1])
    shap_by_feature = {FEATURES[i]: float(vals[i]) for i in range(len(FEATURES))}

    payload = {
        "source": "shap-python",
        "catchupProbability": prob,
        "baseValue": base_value,
        "shapValues": shap_by_feature,
        "riskFactors": build_risk_factors(feat, shap_by_feature),
    }

    # Grade regression SHAP (points /20), when the grade model is available.
    if GRADE_EXPLAINER is not None and GRADE_MODEL is not None:
        graw = GRADE_EXPLAINER.shap_values(x, check_additivity=False)
        gvals = np.asarray(graw)[0]
        gbase = GRADE_EXPLAINER.expected_value
        gbase = float(np.ravel(gbase)[0]) if np.ndim(gbase) > 0 else float(gbase)
        grade_shap = {FEATURES[i]: float(gvals[i]) for i in range(len(FEATURES))}
        payload.update({
            "predictedGrade": float(GRADE_MODEL.predict(x)[0]),
            "gradeBaseValue": gbase,
            "gradeShapValues": grade_shap,
            "gradeFactors": build_grade_factors(feat, grade_shap),
        })

    return payload


if __name__ == "__main__":
    port = int(os.environ.get("SHAP_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
