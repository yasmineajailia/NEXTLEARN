# NextLearn Python ML service (ml/shap_service.py): SHAP predictions + RAG chatbot.
FROM python:3.11-slim AS ml
WORKDIR /app

# build-essential covers native builds pulled in by shap / chromadb wheels.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY ml/requirements.txt ./ml/requirements.txt
RUN pip install --no-cache-dir -r ml/requirements.txt

COPY ml ./ml
COPY data ./data

# Models are committed, but train from the CSV if they are ever absent so the
# image is always self-contained (the service refuses to boot without them).
RUN [ -f ml/models/rf-risk.joblib ] || python ml/train.py

ENV SHAP_HOST=0.0.0.0 \
    SHAP_PORT=8000
EXPOSE 8000

# /health returns 200 once models are loaded and FastAPI is serving. Generous
# start period: importing shap + numba on first boot is slow.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).status==200 else 1)"

CMD ["python", "ml/shap_service.py"]
