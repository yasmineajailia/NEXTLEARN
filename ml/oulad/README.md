# OULAD training — real-data risk & grade models

Trains NextLearn's two production models on the **Open University Learning
Analytics Dataset (OULAD)** — real students, real outcomes — instead of the
synthetic-label data. The models drop into the app unchanged.

## Files

| File | What it does |
|---|---|
| `oulad_features.py` | Turns the raw OULAD CSVs into the exact 8-feature vector the app uses (`PREDICTION_FEATURE_KEYS` order). **Feature definitions live here only** — both notebooks import it, so training and inference can't drift. |
| `train_risk.ipynb` | Trains `RandomForestClassifier` → `rf-risk.joblib` (P(caughtUp)). |
| `train_grade.ipynb` | Trains `RandomForestRegressor` → `rf-grade.joblib` (grade /20). |

## 1. Get the data

Download OULAD (free) from <https://analyse.kmi.open.ac.uk/open_dataset> and
unzip these CSVs into **`ml/oulad/raw/`** (gitignored):

```
studentInfo.csv  studentRegistration.csv  studentVle.csv
assessments.csv  studentAssessment.csv    courses.csv
```

## 2. Train

**Locally:** `jupyter lab` from `ml/oulad/`, open a notebook, **Run All**.
**Colab:** upload the notebook + `oulad_features.py` + the `raw/` CSVs, then Run All.

Each notebook prints honest metrics — held-out test, 5-fold CV, and a
**leave-one-cohort-out** AUC (train on some OU presentations, test on an unseen
one) — then writes its `.joblib`.

## 3. Deploy into the app

Copy the artifacts the ML service loads:

```
ml/oulad/rf-risk.joblib   ->  ml/models/rf-risk.joblib
ml/oulad/rf-grade.joblib  ->  ml/models/rf-grade.joblib
```

Also update the **SHAP-explainer background** so it matches the new training
distribution — the service reads a CSV at startup to compute base values:

```
data/oulad_analytics.csv  ->  replace data/student_analytics.csv
```

Restart the ML service (`npm run dev`). No code changes needed.

## Why it loads unchanged — the contract

- **8 features, exact order** (`FEATURES` in `oulad_features.py` == `PREDICTION_FEATURE_KEYS`). OULAD has no webcam signal, so `avgFocusScore`/`hasAttentionData` are `0` — the forest ignores them, and attention re-activates only when you re-fit on your own data.
- **Tree models** so `shap.TreeExplainer` works (`RandomForest*`). Don't swap in logistic/NN.
- **Risk classes `0/1`, `1 = caughtUp`** — the service reads `predict_proba[:, class==1]`.
- **scikit-learn version** pinned in the notebook to the app's range (`>=1.7`) so the pickle loads.

## Validation & results (from the notebooks)

Metrics are **leakage-free**: cross-validation is grouped by `id_student`, so no
student appears in both train and test (a student can sit several OU modules).

| Model | Metric | Result |
|---|---|---|
| Risk (caughtUp) | student-grouped CV AUC | **0.849 ± 0.003** |
| | held-out AUC / leave-cohort-out AUC | 0.842 / 0.836 |
| Grade (/20) | student-grouped CV MAE | **1.39** |

**EDA** confirms every feature correlates with the outcome in a pedagogically
sensible direction (e.g. `gapDepth` −0.46, `averageScore` +0.45).

**Demographic ablation:** adding all OULAD demographics (gender, region, age,
education, IMD, disability, prior attempts, credits — 43 one-hot columns) lifts
AUC by only **+0.001** (0.849 → 0.850). They are therefore kept **out** of the
deployed model — they add almost nothing, the app can't produce them, and
several are protected attributes that should not drive a risk score. The
ablation is in `train_risk.ipynb` for transparency.

> **Note:** `completionPace` was dropped from the model — its NextLearn units
> (sous-acquis/week) didn't match OULAD's (assessments/week), which unfairly
> penalized fast students. Removing it left AUC unchanged (0.851 → 0.849).

## Honest caveats

- **Domain shift:** OULAD is OU distance-learning modules; NextLearn is one ESPRIT C course. This is a **transfer/proxy** model — better than synthetic, not the same population. Re-fit on NextLearn's own end-of-term outcomes as they accrue.
- **Grade is the weaker half:** the label is the weight-weighted mean of all assessment scores /20 (full-course outcome). It transfers less cleanly across domains than risk — lead with risk; treat grade as indicative.
- **`completionPace`** maps only loosely (OULAD has no sous-acquis granularity) — it's an assessment-throughput proxy.
