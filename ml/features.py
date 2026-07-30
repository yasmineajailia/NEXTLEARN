"""
features.py — the single source of truth for the early-warning models' input
contract: which columns, in which order, and the two label column names.

Previously hand-copied identically in ml/train.py, ml/oulad/oulad_features.py,
and ml/shap_service.py. Order matters here (see FEATURES below), so a copy
that silently drifted out of sync with the others would corrupt predictions
without raising an error — this module exists so there is exactly one place
to change it.

Order MUST match PREDICTION_FEATURE_KEYS in src/services/prediction/features.ts
(the TypeScript side that actually produces these features from live app data;
Python and TypeScript can't share a source file directly, so that side must be
kept in sync by hand — this module only removes the duplication within ml/).
"""

FEATURES = [
    "delayWeeks",
    "averageScore",
    "loginFrequency",
    "gapDepth",
    "recencyRatio",
    "weakSkillRatio",
    "avgFocusScore",
    "hasAttentionData",
]

RISK_LABEL = "caughtUp"
GRADE_LABEL = "examGrade"
