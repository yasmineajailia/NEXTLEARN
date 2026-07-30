"""
routers/risk.py

Risk + grade prediction and SHAP explanation: /predict (fast path, no SHAP)
and /explain (single-student SHAP attributions in probability/grade points).
"""

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel

from features import FEATURES
import service_state as state

router = APIRouter()


class Features(BaseModel):
    delayWeeks: float
    averageScore: float
    loginFrequency: float
    gapDepth: float
    # Newer features default to neutral so any older caller still validates.
    recencyRatio: float = 0.5
    weakSkillRatio: float = 0.0
    avgFocusScore: float = 0.0
    hasAttentionData: float = 0.0


class PredictBody(BaseModel):
    """Batch of feature vectors in FEATURES order (one row per student)."""
    instances: list[list[float]]


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
    if key == "avgFocusScore":
        s = round(f["avgFocusScore"])
        return f"Bonne concentration ({s}%)" if positive else f"Concentration faible ({s}%)"
    if key == "hasAttentionData":
        return "Suivi d'attention actif" if positive else "Pas de données d'attention"
    return key


def build_risk_factors(feat: dict, shap_by_feature: dict) -> list:
    entries = [{"key": k, "value": float(shap_by_feature[k])} for k in state.DISPLAY_FEATURES]
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
    entries = [{"key": k, "value": float(shap_by_feature[k])} for k in state.DISPLAY_FEATURES]
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


@router.post("/predict")
def predict(body: PredictBody):
    """Fast path: batch risk probability + predicted grade, no SHAP."""
    X = np.asarray(body.instances, dtype=float)
    if X.ndim != 2 or X.shape[1] != len(FEATURES):
        return {"error": f"each instance must have {len(FEATURES)} features"}
    probs = state.MODEL.predict_proba(X)[:, state.C1]
    grades = state.GRADE_MODEL.predict(X) if state.GRADE_MODEL is not None else [None] * len(X)
    predictions = []
    for i in range(len(X)):
        g = grades[i]
        g = None if g is None else max(0.0, min(20.0, round(float(g) * 10) / 10))
        predictions.append({"catchupProbability": float(probs[i]), "predictedGrade": g})
    return {"predictions": predictions}


@router.post("/explain")
def explain(body: Features):
    feat = body.model_dump()
    x = np.array([[feat[k] for k in FEATURES]], dtype=float)

    # SHAP values (probability space). Handle both ndarray and per-class list outputs.
    raw = state.EXPLAINER.shap_values(x, check_additivity=False)
    if isinstance(raw, list):
        vals = np.asarray(raw[state.C1])[0]
    else:
        arr = np.asarray(raw)
        vals = arr[0, :, state.C1] if arr.ndim == 3 else arr[0]

    base = state.EXPLAINER.expected_value
    base_value = float(np.ravel(base)[state.C1]) if np.ndim(base) > 0 else float(base)

    prob = float(state.MODEL.predict_proba(x)[0][state.C1])
    shap_by_feature = {FEATURES[i]: float(vals[i]) for i in range(len(FEATURES))}

    payload = {
        "source": "shap-python",
        "catchupProbability": prob,
        "baseValue": base_value,
        "shapValues": shap_by_feature,
        "riskFactors": build_risk_factors(feat, shap_by_feature),
    }

    if state.GRADE_EXPLAINER is not None and state.GRADE_MODEL is not None:
        graw = state.GRADE_EXPLAINER.shap_values(x, check_additivity=False)
        gvals = np.asarray(graw)[0]
        gbase = state.GRADE_EXPLAINER.expected_value
        gbase = float(np.ravel(gbase)[0]) if np.ndim(gbase) > 0 else float(gbase)
        grade_shap = {FEATURES[i]: float(gvals[i]) for i in range(len(FEATURES))}
        payload.update({
            "predictedGrade": state.predict_grade(x),
            "gradeBaseValue": gbase,
            "gradeShapValues": grade_shap,
            "gradeFactors": build_grade_factors(feat, grade_shap),
        })

    return payload
