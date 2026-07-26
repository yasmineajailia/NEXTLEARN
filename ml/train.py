"""
train.py

Trains the two production models NATIVELY in scikit-learn and saves them with
joblib for the FastAPI service to serve directly:

  * rf-risk.joblib   RandomForestClassifier  -> P(caughtUp)      (risk gauge)
  * rf-grade.joblib  RandomForestRegressor   -> examGrade /20    (predicted grade)

This replaces the old JS pipeline (ml-random-forest in scripts/train-*.ts +
ml/js_forest.py reconstruction). One library trains, serves and explains the
models — no JS<->Python tree mirror to keep in sync.

Data: data/student_analytics.csv (columns = the 9 features, then caughtUp,
examGrade). Hyper-parameters mirror the previous forests: 100 trees, max depth
10, seed 42.

Reported metrics are the HONEST ones: a held-out 80/20 test split and 5-fold
cross-validation. Training-set accuracy is meaningless for a forest and is not
reported.

Run:  python ml/train.py     (or: npm run train:model)
"""

import json
import os

import numpy as np
import pandas as pd
from joblib import dump
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import mean_absolute_error, roc_auc_score
from sklearn.model_selection import cross_val_predict, cross_val_score, train_test_split

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CSV_PATH = os.path.join(ROOT, "data", "student_analytics.csv")
MODELS_DIR = os.path.join(HERE, "models")
RISK_OUT = os.path.join(MODELS_DIR, "rf-risk.joblib")
GRADE_OUT = os.path.join(MODELS_DIR, "rf-grade.joblib")
FEATURES_OUT = os.path.join(ROOT, "data", "model-features.json")

SEED = 42
N_ESTIMATORS = 100
MAX_DEPTH = 10

# Order MUST match PREDICTION_FEATURE_KEYS in src/services/prediction/features.ts.
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


def main() -> None:
    df = pd.read_csv(CSV_PATH)
    missing = [c for c in FEATURES + [RISK_LABEL, GRADE_LABEL] if c not in df.columns]
    if missing:
        raise SystemExit(f"student_analytics.csv is missing columns: {missing}")

    X = df[FEATURES].astype(float).values
    y_risk = df[RISK_LABEL].astype(int).values
    y_grade = df[GRADE_LABEL].astype(float).values
    print(f"[train] {len(df)} rows, {len(FEATURES)} features")

    # ---- Risk classifier -------------------------------------------------
    clf = RandomForestClassifier(
        n_estimators=N_ESTIMATORS, max_depth=MAX_DEPTH, random_state=SEED, n_jobs=-1
    )

    Xtr, Xte, ytr, yte = train_test_split(X, y_risk, test_size=0.2, random_state=SEED, stratify=y_risk)
    clf.fit(Xtr, ytr)
    test_acc = clf.score(Xte, yte)
    test_auc = roc_auc_score(yte, clf.predict_proba(Xte)[:, 1])

    cv_acc = cross_val_score(clf, X, y_risk, cv=5, scoring="accuracy")
    cv_auc = cross_val_score(clf, X, y_risk, cv=5, scoring="roc_auc")

    # Refit on ALL data for deployment.
    clf.fit(X, y_risk)

    # ---- Grade regressor -------------------------------------------------
    reg = RandomForestRegressor(
        n_estimators=N_ESTIMATORS, max_depth=MAX_DEPTH, random_state=SEED, n_jobs=-1
    )
    gXtr, gXte, gytr, gyte = train_test_split(X, y_grade, test_size=0.2, random_state=SEED)
    reg.fit(gXtr, gytr)
    test_mae = mean_absolute_error(gyte, reg.predict(gXte))
    cv_pred = cross_val_predict(reg, X, y_grade, cv=5)
    cv_mae = mean_absolute_error(y_grade, cv_pred)
    reg.fit(X, y_grade)

    # ---- Persist ---------------------------------------------------------
    os.makedirs(MODELS_DIR, exist_ok=True)
    dump(clf, RISK_OUT)
    dump(reg, GRADE_OUT)
    with open(FEATURES_OUT, "w", encoding="utf-8") as fh:
        json.dump(FEATURES, fh, indent=2)

    # ---- Honest report ---------------------------------------------------
    print("\n=== Risk classifier (caughtUp) ===")
    print(f"  held-out test : acc {test_acc:.3f} | AUC {test_auc:.3f}")
    print(f"  5-fold CV     : acc {cv_acc.mean():.3f} +/- {cv_acc.std():.3f} | "
          f"AUC {cv_auc.mean():.3f} +/- {cv_auc.std():.3f}")
    print("=== Grade regressor (examGrade /20) ===")
    print(f"  held-out test : MAE {test_mae:.3f}")
    print(f"  5-fold CV     : MAE {cv_mae:.3f}")
    print(f"\n[train] saved:\n  {RISK_OUT}\n  {GRADE_OUT}\n  {FEATURES_OUT}")


if __name__ == "__main__":
    main()
