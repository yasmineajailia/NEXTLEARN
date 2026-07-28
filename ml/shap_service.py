"""
shap_service.py

FastAPI microservice that serves the platform's data-science layer: it predicts
AND explains the two production models, loaded NATIVELY from joblib (trained by
ml/train.py). There is no JS<->Python mirror anymore — one scikit-learn model
per task is trained, served and explained here.

Endpoints:
  GET  /health            liveness + model metadata
  POST /predict           batch risk + grade predictions (no SHAP — fast path)
  POST /explain           single-student risk + grade + SHAP attributions

SHAP setup: interventional feature perturbation + model_output="probability"
means the classifier's SHAP values are in PROBABILITY POINTS and additive:
    predict_proba(x)[caughtUp] = base_value + sum(shap_values)
The grade regressor's SHAP values are in GRADE POINTS (/20), additive to the
predicted grade.

Run:  python ml/shap_service.py         (defaults to 127.0.0.1:8000)
      SHAP_PORT=8000 python ml/shap_service.py

The Node backend auto-starts and supervises this service (see
src/services/prediction/shapSupervisor.ts) and depends on it for predictions —
there is no JS prediction fallback.
"""

import os
from collections import Counter

import numpy as np
import pandas as pd
import shap
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from joblib import load
from pydantic import BaseModel
from sklearn.cluster import KMeans

# Load the project .env so LLM keys are available when run standalone. When the
# Node supervisor spawns this service, the keys are already inherited from
# process.env; load_dotenv does not override existing env vars.
load_dotenv()

from quizgen import generate_quiz
import item_analysis
from rag import index as rag_index
from rag import retrieve as rag_retrieve
from rag import store as rag_store
from rag import guards as rag_guards
from rag import generate as rag_generate
from rag import answer_gap as rag_answer_gap
from kt import infer as kt_infer
from kt import skill_graph as kt_graph

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RISK_MODEL_PATH = os.path.join(HERE, "models", "rf-risk.joblib")
GRADE_MODEL_PATH = os.path.join(HERE, "models", "rf-grade.joblib")
CSV_PATH = os.path.join(ROOT, "data", "student_analytics.csv")
BACKGROUND_SIZE = 100

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

# SAKT knowledge-tracing model (per-skill mastery). Loads once; when the weights
# are absent it stays unavailable and /mastery serves the recency fallback only.
KT_MODEL = kt_infer.KTModel()


def _class1_index() -> int:
    classes = list(getattr(MODEL, "classes_", [0, 1]))
    return classes.index(1) if 1 in classes else len(classes) - 1


C1 = _class1_index()


def _predict_grade(x: np.ndarray) -> float | None:
    if GRADE_MODEL is None:
        return None
    g = float(GRADE_MODEL.predict(x)[0])
    return max(0.0, min(20.0, round(g * 10) / 10))


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
    entries = [{"key": k, "value": float(shap_by_feature[k])} for k in DISPLAY_FEATURES]
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
    entries = [{"key": k, "value": float(shap_by_feature[k])} for k in DISPLAY_FEATURES]
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


class ClusterBody(BaseModel):
    """Normalized student points to segment into k learning-profile clusters."""
    points: list[list[float]]
    k: int = 3


class AttentionStudent(BaseModel):
    """One student's derived attention history — NO frames/landmarks, by design.
    avgScores: chronological per-session focus scores. distractions: flat list of
    distraction reason codes across sessions."""
    avgScores: list[float] = []
    distractions: list[str] = []


class AttentionBody(BaseModel):
    students: list[AttentionStudent]


class QuizGenBody(BaseModel):
    moduleId: str = ""
    moduleName: str = ""
    acquisName: str = ""
    subAcquisId: str = ""
    subAcquisName: str = ""
    topic: str = ""
    difficulty: str = "intermediate"
    count: int = 5
    courseContent: list[str] = []


class RagReindexBody(BaseModel):
    """Node posts the persisted curriculum modules; Python fetches course files,
    embeds new chunks and upserts them into the Chroma store."""
    modules: list[dict] = []
    baseUrl: str = ""
    reset: bool = False


class RagRetrieveBody(BaseModel):
    question: str = ""
    allowedModuleIds: list[str] = []
    allowedSubAcquisIds: list[str] = []
    filterToModuleId: str | None = None
    filterToSubAcquisId: str | None = None
    k: int = 6


class ChatTurn(BaseModel):
    role: str
    content: str


class LearnerProfile(BaseModel):
    """Derived, non-sensitive learner context used to personalize HOW the
    chatbot answers (tone/format/reinforcement) — never to invent facts."""
    name: str | None = None
    level: int | None = None
    vark: str | None = None
    weakAreas: list[str] = []
    currentLesson: str | None = None


class RagAnswerBody(BaseModel):
    question: str = ""
    allowedModuleIds: list[str] = []
    allowedSubAcquisIds: list[str] = []
    filterToModuleId: str | None = None
    filterToSubAcquisId: str | None = None
    history: list[ChatTurn] = []
    lang: str = "fr"
    learnerProfile: LearnerProfile | None = None


class KTInteraction(BaseModel):
    skillId: str
    correct: bool


class MasteryBody(BaseModel):
    """A student's ordered attempt history + the skills to score.

    history is oldest->newest; each skillId is a curriculum skill (a sous-acquis
    id for the app, an OULAD assessment id for the shipped demo model)."""
    history: list[KTInteraction] = []
    targetSkillIds: list[str] = []
    applyGraph: bool = True  # refine mastery over the prerequisite graph


class AnswerGapBody(BaseModel):
    """A student's free-text explanation of a lesson, to compare against the
    lesson's own indexed content (semantic gap analysis)."""
    moduleId: str = ""
    subAcquisId: str = ""
    text: str = ""
    lang: str = "fr"


class ItemAnalysisBody(BaseModel):
    """Per-question responses for one quiz. Each attempt carries the gradable
    responses captured in User.progress.skillAttempts."""
    attempts: list[dict] = []


class UTF8JSONResponse(JSONResponse):
    """FastAPI's default JSONResponse encodes UTF-8 but ships `Content-Type:
    application/json` with NO charset. Spec-compliant clients (browsers, Node
    fetch) always decode JSON as UTF-8, but some do not — PowerShell's
    Invoke-WebRequest / `curl` default to ISO-8859-1 when no charset is given,
    which turns accented French (e.g. 'problème') into mojibake ('problÃ¨me').
    Advertising the charset makes every client decode correctly."""
    media_type = "application/json; charset=utf-8"


app = FastAPI(title="NextLearn ML service", version="2.0", default_response_class=UTF8JSONResponse)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "library": "scikit-learn + shap",
        "shap": shap.__version__,
        "model": "RandomForest (native sklearn, joblib)",
        "trees": len(MODEL.estimators_),
        "gradeModel": GRADE_MODEL is not None,
        # Whether the LLM/embeddings key is loaded. The supervisor uses this to
        # avoid ADOPTING a stale instance started without .env, which would answer
        # /health but silently fail every RAG/chatbot request.
        "apiKeyLoaded": bool(os.environ.get("OPENAI_API_KEY")),
        "features": FEATURES,
    }


@app.post("/predict")
def predict(body: PredictBody):
    """Fast path: batch risk probability + predicted grade, no SHAP."""
    X = np.asarray(body.instances, dtype=float)
    if X.ndim != 2 or X.shape[1] != len(FEATURES):
        return {"error": f"each instance must have {len(FEATURES)} features"}
    probs = MODEL.predict_proba(X)[:, C1]
    grades = GRADE_MODEL.predict(X) if GRADE_MODEL is not None else [None] * len(X)
    predictions = []
    for i in range(len(X)):
        g = grades[i]
        g = None if g is None else max(0.0, min(20.0, round(float(g) * 10) / 10))
        predictions.append({"catchupProbability": float(probs[i]), "predictedGrade": g})
    return {"predictions": predictions}


@app.post("/cluster")
def cluster(body: ClusterBody):
    """K-Means over normalized student vectors (learning-profile segmentation)."""
    pts = np.asarray(body.points, dtype=float)
    n = len(pts)
    if n == 0:
        return {"assignments": [], "centroids": [], "iterations": 0, "converged": True}
    k = max(1, min(int(body.k), n))
    max_iter = 100
    km = KMeans(n_clusters=k, n_init=10, max_iter=max_iter, random_state=42)
    labels = km.fit_predict(pts)
    return {
        "assignments": labels.astype(int).tolist(),
        "centroids": km.cluster_centers_.tolist(),
        "iterations": int(km.n_iter_),
        "converged": bool(km.n_iter_ < max_iter),
    }


def _focus_trend(scores: list) -> str:
    """last-3 vs previous-3 mean focus: >+5 improving, <-5 declining, else stable."""
    if len(scores) < 6:
        return "stable"
    last3 = scores[-3:]
    prev3 = scores[-6:-3]
    delta = (sum(last3) / 3.0) - (sum(prev3) / 3.0)
    if delta > 5:
        return "improving"
    if delta < -5:
        return "declining"
    return "stable"


def _top_distraction(reasons: list):
    counts = Counter(r for r in reasons if r)
    return counts.most_common(1)[0][0] if counts else None


@app.post("/attention-analytics")
def attention_analytics(body: AttentionBody):
    """Teacher-dashboard analytics over DERIVED attention metrics only (no biometrics
    ever reach the server — frame scoring stays in the browser). Batched per class."""
    results = [
        {"trend": _focus_trend(st.avgScores), "topDistraction": _top_distraction(st.distractions)}
        for st in body.students
    ]
    return {"results": results}


@app.post("/rag/reindex")
def rag_reindex(body: RagReindexBody):
    """Build/refresh the student RAG vector store (Chroma) from the curriculum."""
    return rag_index.reindex(body.modules, base_url=body.baseUrl, reset=body.reset)


@app.get("/rag/stats")
def rag_stats():
    return {"storeCount": rag_store.count()}


@app.post("/rag/retrieve")
def rag_retrieve_endpoint(body: RagRetrieveBody):
    """Retrieve top-k chunks (vector or lexical) + the scope/grounding guard flags."""
    chunks = rag_retrieve.retrieve(
        body.question,
        body.allowedModuleIds,
        body.allowedSubAcquisIds,
        filter_module=body.filterToModuleId,
        filter_sub=body.filterToSubAcquisId,
        k=body.k,
    )
    refined = rag_retrieve.refine_chunks(body.question, chunks)
    return {
        "chunks": [
            {
                "moduleId": c.get("moduleId"),
                "moduleName": c.get("moduleName"),
                "subAcquisId": c.get("subAcquisId"),
                "subAcquisName": c.get("subAcquisName"),
                "kind": c.get("kind"),
                "text": c.get("text"),
            }
            for c in refined
        ],
        "guards": {
            "hasGrounding": rag_guards.has_meaningful_grounding(body.question, chunks),
            "outsideLangageC": rag_guards.is_outside_langage_c(body.question),
            "ambiguousProgramming": rag_guards.is_ambiguous_programming(body.question),
        },
    }


@app.post("/rag/answer")
def rag_answer_endpoint(body: RagAnswerBody):
    """Buffered student chatbot answer: retrieve -> guard -> LLM -> grounded check
    -> deterministic fallback. Node does access control + passes allowed ids."""
    return rag_generate.answer(
        body.question,
        body.allowedModuleIds,
        body.allowedSubAcquisIds,
        filter_module=body.filterToModuleId,
        filter_sub=body.filterToSubAcquisId,
        history=[t.model_dump() for t in body.history],
        lang="en" if body.lang == "en" else "fr",
        learner_profile=body.learnerProfile.model_dump() if body.learnerProfile else None,
    )


@app.post("/rag/stream")
def rag_stream_endpoint(body: RagAnswerBody):
    """Streaming student chatbot answer (SSE). Emits meta/delta/sources/done frames
    that Node proxies straight to the browser. Node does access control + passes
    allowed ids; the 'no access' case is handled by Node before it reaches here."""
    gen = rag_generate.stream_answer(
        body.question,
        body.allowedModuleIds,
        body.allowedSubAcquisIds,
        filter_module=body.filterToModuleId,
        filter_sub=body.filterToSubAcquisId,
        history=[t.model_dump() for t in body.history],
        lang="en" if body.lang == "en" else "fr",
        learner_profile=body.learnerProfile.model_dump() if body.learnerProfile else None,
    )
    return StreamingResponse(gen, media_type="text/event-stream; charset=utf-8")


@app.post("/mastery")
def mastery_endpoint(body: MasteryBody):
    """Per-skill mastery from the SAKT knowledge-tracing model.

    Returns P(correct-next) for each requested skill, given the student's attempt
    history. `source` per skill is "sakt" (neural estimate), "history" (recency
    fallback for a skill outside the model's vocabulary) or "prior" (no attempts)."""
    history = [(it.skillId, it.correct) for it in body.history]
    scores = KT_MODEL.mastery(history, body.targetSkillIds)
    resp = {
        "available": KT_MODEL.available,
        "testAuc": round(getattr(KT_MODEL, "test_auc", 0.0), 4),
        "mastery": scores,
        "graphApplied": False,
    }
    if body.applyGraph:
        graph = kt_graph.get_graph()
        if graph is not None:
            smoothed = graph.smooth(scores)
            resp["mastery"] = smoothed
            resp["revisionOrder"] = graph.revision_order(smoothed)
            resp["graphApplied"] = True
    return resp


@app.post("/nlp/answer-gap")
def answer_gap_endpoint(body: AnswerGapBody):
    """Semantic gap analysis: which key concepts of the lesson does the
    student's own-words explanation cover / miss. Reference = the lesson's
    indexed chunks; embeddings with a lexical fallback."""
    return rag_answer_gap.analyze(
        body.moduleId, body.subAcquisId, body.text,
        lang="en" if body.lang == "en" else "fr",
    )


@app.post("/generate-quiz")
def generate_quiz_endpoint(body: QuizGenBody):
    """Teacher quiz generation (LLM, with a template fallback). Returns validated
    questions. Node passes the resolved sous-acquis + course-content snippets."""
    return {"questions": generate_quiz(body.model_dump())}


@app.post("/item-analysis")
def item_analysis_endpoint(body: ItemAnalysisBody):
    """Classical item analysis (difficulty + rest-corrected point-biserial
    discrimination + KR-20 reliability) for one quiz, so teachers can spot broken
    / too-easy / too-hard AI-generated questions from real student responses."""
    return item_analysis.analyze(body.attempts)


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

    if GRADE_EXPLAINER is not None and GRADE_MODEL is not None:
        graw = GRADE_EXPLAINER.shap_values(x, check_additivity=False)
        gvals = np.asarray(graw)[0]
        gbase = GRADE_EXPLAINER.expected_value
        gbase = float(np.ravel(gbase)[0]) if np.ndim(gbase) > 0 else float(gbase)
        grade_shap = {FEATURES[i]: float(gvals[i]) for i in range(len(FEATURES))}
        payload.update({
            "predictedGrade": _predict_grade(x),
            "gradeBaseValue": gbase,
            "gradeShapValues": grade_shap,
            "gradeFactors": build_grade_factors(feat, grade_shap),
        })

    return payload


if __name__ == "__main__":
    port = int(os.environ.get("SHAP_PORT", "8000"))
    # Bind loopback by default (safe for the local Node supervisor). Containers
    # set SHAP_HOST=0.0.0.0 so the app container can reach the service.
    host = os.environ.get("SHAP_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="warning")
