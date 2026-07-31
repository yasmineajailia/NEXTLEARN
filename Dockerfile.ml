# NextLearn Python ML service (ml/shap_service.py): SHAP predictions + RAG chatbot.
FROM python:3.11-slim AS ml
WORKDIR /app

# build-essential covers native builds pulled in by shap / chromadb wheels.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY ml/requirements.txt ./ml/requirements.txt

# Install torch FIRST, from PyTorch's CPU wheel index. The default PyPI wheel
# bundles the CUDA runtime (~2-3GB) which is dead weight on a CPU-only server.
# The CPU builds carry a "+cpu" local version, which PEP 440 sorts above the
# plain PyPI version, so pip prefers them; installing it up front also means
# the `torch` line in requirements.txt below is already satisfied and won't
# pull the CUDA build back in.
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu "torch>=2.2"
RUN pip install --no-cache-dir -r ml/requirements.txt

# Bake the NLI cross-encoder into the image. Without this, the FIRST student to
# use "explain in your own words" triggers a ~1GB HuggingFace download inside
# the request, and because nothing persists the cache it repeats on every
# container recreate — and silently degrades to similarity-only scoring if the
# server has no outbound internet. Baking it makes startup deterministic and
# offline-safe. HF_HOME must stay set at runtime so the loader finds it here;
# do NOT mount a volume over this path or it will shadow the baked model.
# Overriding ANSWER_GAP_NLI_MODEL at runtime reintroduces a runtime download.
ARG NLI_MODEL=MoritzLaurer/mDeBERTa-v3-base-mnli-xnli
ENV ANSWER_GAP_NLI_MODEL=${NLI_MODEL} \
    HF_HOME=/opt/hf-cache
RUN python -c "\
from transformers import AutoModelForSequenceClassification, AutoTokenizer; \
import os; m = os.environ['ANSWER_GAP_NLI_MODEL']; \
AutoTokenizer.from_pretrained(m); \
AutoModelForSequenceClassification.from_pretrained(m); \
print('[build] pre-cached ' + m)"

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
