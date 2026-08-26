"""
shap_service.py

FastAPI microservice that serves the platform's data-science layer: it predicts
AND explains the two production models, loaded NATIVELY from joblib (trained by
ml/train.py). There is no JS<->Python mirror anymore — one scikit-learn model
per task is trained, served and explained here.

Endpoints are grouped by domain into ml/routers/* (risk/grade SHAP, clustering,
attention analytics, RAG/chatbot, mastery estimation, quiz tooling) and
mounted below. This file owns app setup, the singleton model state
(ml/service_state.py, loaded once and imported by every router) and /health:

  GET  /health              liveness + model metadata
  POST /predict              batch risk + grade predictions (no SHAP — fast path)
  POST /explain               single-student risk + grade + SHAP attributions
  POST /cluster                K-Means learning-profile segmentation
  POST /attention-analytics    focus trend + top distraction per student
  POST /rag/reindex, GET /rag/stats, POST /rag/retrieve, /rag/answer, /rag/stream
  POST /nlp/answer-gap          semantic lesson-explanation gap analysis
  POST /mastery                 per-sous-acquis mastery (recency + graph)
  POST /generate-quiz           LLM quiz generation
  POST /item-analysis           classical item analysis (difficulty/discrimination)

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

import shap
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI

# Load the project .env so LLM keys are available when run standalone. When the
# Node supervisor spawns this service, the keys are already inherited from
# process.env; load_dotenv does not override existing env vars.
load_dotenv()

import service_state as state
from features import FEATURES
from routers import risk, clustering, attention, rag_routes, mastery, quiz

app = FastAPI(title="NextLearn ML service", version="2.0", default_response_class=state.UTF8JSONResponse)

app.include_router(risk.router)
app.include_router(clustering.router)
app.include_router(attention.router)
app.include_router(rag_routes.router)
app.include_router(mastery.router)
app.include_router(quiz.router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "library": "scikit-learn + shap",
        "shap": shap.__version__,
        "model": "RandomForest (native sklearn, joblib)",
        "trees": len(state.MODEL.estimators_),
        "gradeModel": state.GRADE_MODEL is not None,
        # Whether the LLM/embeddings key is loaded. The supervisor uses this to
        # avoid ADOPTING a stale instance started without .env, which would answer
        # /health but silently fail every RAG/chatbot request.
        "apiKeyLoaded": bool(os.environ.get("OPENAI_API_KEY")),
        "features": FEATURES,
    }


if __name__ == "__main__":
    port = int(os.environ.get("SHAP_PORT", "8000"))
    # Bind loopback by default (safe for the local Node supervisor). Containers
    # set SHAP_HOST=0.0.0.0 so the app container can reach the service.
    host = os.environ.get("SHAP_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="warning")
