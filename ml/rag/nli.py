"""
nli.py — multilingual textual-entailment (NLI) cross-encoder, used as the
verification stage of the answer-gap pipeline.

Why: bi-encoder cosine similarity answers "do these texts talk about the same
thing?", not "did the student actually explain it?". A cross-encoder reads the
student text and the concept JOINTLY (cross-attention) and outputs
P(entailment), which correctly rejects mere mentions ("je ne comprends pas
l'exécution") and contradictions — the failure modes of similarity alone.

Model: a multilingual XNLI cross-encoder (French + English out of the box, so
one model serves both interface languages, including a student answering in
English about French course content). The default is mDeBERTa-v3-base (~80%
XNLI accuracy) — the distilled MiniLM alternative proved too noisy on real
answers (false rescues/demotions). Set ANSWER_GAP_NLI_MODEL to
"MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli" for a faster, lighter model.

Lazy-loaded on first use; every failure path returns None so the caller keeps
its embedding-only behaviour (graceful degradation, same pattern as embed.py).
"""

import os
import threading

MODEL_NAME = os.environ.get(
    "ANSWER_GAP_NLI_MODEL", "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli"
)
MAX_PREMISE_TOKENS = 512

_lock = threading.Lock()
_state: dict = {"tried": False, "tokenizer": None, "model": None, "entail_idx": None}


def _load():
    """One-shot lazy load (thread-safe). Failure is remembered so a missing
    model/dependency costs one attempt, not one per request."""
    with _lock:
        if _state["tried"]:
            return
        _state["tried"] = True
        try:
            import torch  # noqa: F401 — presence check
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
            model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME)
            model.eval()
            # Label order differs across NLI checkpoints — resolve from config.
            id2label = {int(k): str(v).lower() for k, v in model.config.id2label.items()}
            entail_idx = next((i for i, lab in id2label.items() if "entail" in lab), None)
            if entail_idx is None:
                raise RuntimeError(f"no entailment label in {id2label}")
            _state.update(tokenizer=tokenizer, model=model, entail_idx=entail_idx)
            print(f"[nli] loaded {MODEL_NAME} (entailment index {entail_idx})")
        except Exception as exc:  # noqa: BLE001 — transformers/model absent
            print(f"[nli] unavailable ({type(exc).__name__}: {exc}) — similarity-only mode")


def available() -> bool:
    _load()
    return _state["model"] is not None


def entail_probs(premise: str, hypotheses: list) -> list | None:
    """P(premise entails hypothesis) for each hypothesis, in one batch.
    Returns None when the model is unavailable or inference fails."""
    if not hypotheses:
        return []
    if not available():
        return None
    try:
        import torch

        tokenizer, model, entail_idx = _state["tokenizer"], _state["model"], _state["entail_idx"]
        enc = tokenizer(
            [premise] * len(hypotheses),
            list(hypotheses),
            truncation=True,
            max_length=MAX_PREMISE_TOKENS,
            padding=True,
            return_tensors="pt",
        )
        with torch.no_grad():
            logits = model(**enc).logits
        probs = torch.softmax(logits, dim=-1)[:, entail_idx]
        return [float(p) for p in probs]
    except Exception as exc:  # noqa: BLE001 — inference failure -> similarity-only
        print(f"[nli] inference failed ({type(exc).__name__}: {exc})")
        return None
