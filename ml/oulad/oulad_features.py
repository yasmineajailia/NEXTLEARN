"""
oulad_features.py

Turns the raw OULAD CSVs into the EXACT 8-feature vector NextLearn's models
consume. The column order and every feature definition mirror
`PREDICTION_FEATURE_KEYS` / `computePredictionFeatures` in
src/services/prediction/features.ts — so a model trained here scores real
NextLearn students without the train/inference distributions drifting apart.

Both training notebooks import this module, so the feature math lives in ONE
versioned place instead of being copy-pasted into notebook cells.

Features are computed at an early CUTOFF_DAY (days since the module started),
which makes the models early-warning predictors: "given the first weeks of
behaviour, will the student pass?" — exactly how the app uses them mid-course.

Raw CSVs expected in ml/oulad/raw/ (free download from the Open University):
  studentInfo, studentRegistration, studentVle,
  assessments, studentAssessment, courses   (.csv)
"""

import os
import sys

import numpy as np
import pandas as pd

# ml/oulad/ isn't a package (no __init__.py) and this module is imported from
# notebooks/scripts run from varying working directories, so unlike train.py
# and shap_service.py (which can rely on Python auto-adding their own script
# directory, ml/, to sys.path) this needs an explicit bootstrap to find
# ml/features.py, the shared source of truth for FEATURES/RISK_LABEL/GRADE_LABEL.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from features import FEATURES, RISK_LABEL, GRADE_LABEL  # noqa: E402

KEYS = ["code_module", "code_presentation", "id_student"]

# OULAD demographics — NOT part of the deployed model (the app can't produce
# them, and gender/imd/age/disability are protected attributes that should not
# drive a risk score). Exposed only via `include_demographics=True` so a
# notebook can *measure* how much they would help (an ablation), transparently.
DEMOGRAPHIC_COLS = [
    "gender", "region", "highest_education", "imd_band",
    "age_band", "num_of_prev_attempts", "studied_credits", "disability",
]

# Same constants as features.ts, so definitions match at inference time.
WEAK_SCORE_THRESHOLD = 60     # a quiz/assessment below this is "weak"
RECENCY_WINDOW_DAYS = 28      # dormant beyond this -> recency 0
DEFAULT_AVG_SCORE = 50.0      # no scores yet -> neutral 50 (features.ts default)

# OULAD has no webcam attention signal, so both attention columns are 0. The
# `hasAttentionData` indicator being 0 tells the forest to ignore avgFocusScore,
# exactly as features.ts intends — the attention feature stays dormant in the
# OULAD-trained model and re-activates only when you re-fit on your own data.
DEFAULT_FOCUS = 0.0
DEFAULT_HAS_ATTENTION = 0.0


def _num(series):
    return pd.to_numeric(series, errors="coerce")


def load_raw(raw_dir):
    """Loads the OULAD CSVs needed for the 8 features (vle.csv activity metadata
    is not needed — we use raw click activity, not activity types)."""
    def path_for(name):
        path = os.path.join(raw_dir, name + ".csv")
        if not os.path.exists(path):
            raise FileNotFoundError(f"Missing {path} — download OULAD into {raw_dir}/")
        return path

    # studentVle is large (~450MB / 10M+ rows). Read only the needed columns with
    # compact dtypes so it fits in memory (and stays friendly in Colab).
    svle = pd.read_csv(
        path_for("studentVle"),
        usecols=["code_module", "code_presentation", "id_student", "date", "sum_click"],
        dtype={"id_student": "int32", "date": "int32", "sum_click": "int32"},
    )
    return {
        "info": pd.read_csv(path_for("studentInfo")),
        "reg": pd.read_csv(path_for("studentRegistration")),
        "svle": svle,
        "assess": pd.read_csv(path_for("assessments")),
        "sassess": pd.read_csv(path_for("studentAssessment")),
        "courses": pd.read_csv(path_for("courses")),
    }


def build_dataset(raw_dir="raw", cutoff_day=90, include_demographics=False):
    """Builds one row per (module, presentation, student) with the 8 features
    computed from data up to `cutoff_day`, plus the caughtUp and examGrade
    labels. Returns a DataFrame with KEYS + FEATURES + [RISK_LABEL, GRADE_LABEL].

    When `include_demographics=True`, appends the raw OULAD demographic columns
    (DEMOGRAPHIC_COLS) for *analysis only* — they are never used by the deployed
    model, which stays on the 8 app-producible FEATURES.
    """
    d = load_raw(raw_dir)
    info, reg, svle, assess, sassess = d["info"], d["reg"], d["svle"], d["assess"], d["sassess"]

    # --- Cohort: registered by the cutoff and still enrolled at it. Predicting
    #     withdrawal that already happened before the cutoff would be leaky. ---
    reg = reg.copy()
    reg["date_registration"] = _num(reg["date_registration"]).fillna(0)
    reg["date_unregistration"] = _num(reg["date_unregistration"])
    base = info.merge(reg, on=KEYS, how="left")
    still_enrolled = (base["date_registration"] <= cutoff_day) & (
        base["date_unregistration"].isna() | (base["date_unregistration"] > cutoff_day)
    )
    base = base[still_enrolled].copy()
    base["weeks"] = np.maximum(1.0, (cutoff_day - np.maximum(0, base["date_registration"])) / 7.0)

    # --- Assessments submitted by the cutoff (early performance). ---
    sa = sassess.merge(
        assess[["id_assessment", "code_module", "code_presentation", "assessment_type", "date"]],
        on="id_assessment", how="left",
    )
    sa["date_submitted"] = _num(sa["date_submitted"])
    sa["due"] = _num(sa["date"])
    sa["score"] = _num(sa["score"])
    sa_early = sa[sa["date_submitted"] <= cutoff_day].copy()
    sa_early["late_weeks"] = np.maximum(0.0, sa_early["date_submitted"] - sa_early["due"]) / 7.0

    grp = sa_early.groupby(KEYS)
    agg = grp.agg(
        avg_score=("score", "mean"),
        n_submitted=("score", "count"),
        last_submit=("date_submitted", "max"),
        avg_late_weeks=("late_weeks", "mean"),
    ).reset_index()
    weak = (
        grp["score"].apply(lambda s: float((s < WEAK_SCORE_THRESHOLD).mean()) if len(s) else 0.0)
        .rename("weak_ratio").reset_index()
    )
    agg = agg.merge(weak, on=KEYS, how="left")

    # Assessments DUE by the cutoff, per module-presentation -> expected workload.
    due_counts = (
        assess[_num(assess["date"]) <= cutoff_day]
        .groupby(["code_module", "code_presentation"])["id_assessment"].count()
        .rename("n_due").reset_index()
    )

    # --- VLE engagement up to the cutoff (real click activity). ---
    svle = svle.copy()
    svle["date"] = _num(svle["date"])
    svle["sum_click"] = _num(svle["sum_click"]).fillna(0)
    svle_early = svle[(svle["date"] >= 0) & (svle["date"] <= cutoff_day) & (svle["sum_click"] > 0)]
    ve = svle_early.groupby(KEYS).agg(
        active_days=("date", "nunique"),
        last_active=("date", "max"),
    ).reset_index()

    # --- Assemble. ---
    df = (
        base[KEYS + ["weeks", "final_result"]]
        .merge(agg, on=KEYS, how="left")
        .merge(ve, on=KEYS, how="left")
        .merge(due_counts, on=["code_module", "code_presentation"], how="left")
    )
    for col, fill in {
        "avg_score": DEFAULT_AVG_SCORE, "weak_ratio": 0.0, "n_submitted": 0.0,
        "avg_late_weeks": 0.0, "active_days": 0.0, "n_due": 0.0,
    }.items():
        df[col] = df[col].fillna(fill)

    # --- The 8 features (same definitions/ranges as features.ts). ---
    df["averageScore"] = np.clip(df["avg_score"], 0, 100)
    df["weakSkillRatio"] = np.clip(df["weak_ratio"], 0, 1)
    df["loginFrequency"] = np.clip(df["active_days"] / df["weeks"], 0, 14)
    df["gapDepth"] = np.clip(
        np.where(df["n_due"] > 0, 1.0 - df["n_submitted"] / df["n_due"], 0.0), 0, 1
    )

    last_activity = df[["last_active", "last_submit"]].max(axis=1)
    idle_days = cutoff_day - last_activity
    df["recencyRatio"] = np.clip(
        np.where(last_activity.notna(), 1.0 - idle_days / RECENCY_WINDOW_DAYS, 0.0), 0, 1
    )

    missed = np.maximum(0.0, df["n_due"] - df["n_submitted"])
    df["delayWeeks"] = np.clip(missed + df["avg_late_weeks"], 0, 12)

    df["avgFocusScore"] = DEFAULT_FOCUS
    df["hasAttentionData"] = DEFAULT_HAS_ATTENTION

    # --- Labels. ---
    df["caughtUp"] = df["final_result"].isin(["Pass", "Distinction"]).astype(int)

    # Final module grade /20 = weight-weighted mean of ALL the student's
    # assessment scores (0-100), scaled by 0.2. This is the OUTCOME we predict,
    # so — unlike the features — it legitimately uses full-course data. NaN only
    # when the student never submitted a scored assessment.
    gm = sassess.merge(
        assess[["id_assessment", "code_module", "code_presentation", "weight"]],
        on="id_assessment", how="left",
    )
    gm["score"] = _num(gm["score"])
    gm["weight"] = _num(gm["weight"]).fillna(1.0)

    def _weighted_grade(group):
        s = group["score"].to_numpy(dtype=float)
        w = group["weight"].to_numpy(dtype=float)
        ok = np.isfinite(s)
        if not ok.any():
            return np.nan
        ws = w[ok]
        return float(np.average(s[ok], weights=ws)) if ws.sum() > 0 else float(s[ok].mean())

    grade100 = gm.groupby(KEYS).apply(_weighted_grade).rename("grade100").reset_index()
    df = df.merge(grade100, on=KEYS, how="left")
    df["examGrade"] = np.clip(df["grade100"] * 0.2, 0, 20)  # /20; NaN only if no scored assessment

    out_cols = KEYS + FEATURES + [RISK_LABEL, GRADE_LABEL]
    if include_demographics:
        df = df.merge(d["info"][KEYS + DEMOGRAPHIC_COLS], on=KEYS, how="left")
        out_cols = out_cols + DEMOGRAPHIC_COLS
    return df[out_cols].copy()


def to_training_csv(df, path):
    """Writes FEATURES + labels in the exact column order train.py / shap_service.py
    expect. Use this file as the SHAP-explainer background too (replace or point
    CSV_PATH at data/student_analytics.csv)."""
    cols = FEATURES + [RISK_LABEL, GRADE_LABEL]
    df[cols].to_csv(path, index=False)
    return path
