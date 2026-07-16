"""
embed.py — text embeddings via the same external providers as the old llm.ts
(Gemini preferred when GEMINI_API_KEY is set, otherwise OpenAI-compatible).

Keeping the same provider/model means existing embedding dimensions are
preserved, so we don't have to re-embed anything that was already indexed.
"""

import os

import requests

EMBED_TIMEOUT_S = 60


def has_provider() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENAI_API_KEY"))


def _openai(texts: list) -> list:
    key = os.environ["OPENAI_API_KEY"]
    base = os.environ.get("OPENAI_EMBEDDING_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
    r = requests.post(
        f"{base}/embeddings",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"model": model, "input": texts},
        timeout=EMBED_TIMEOUT_S,
    )
    r.raise_for_status()
    data = sorted(r.json().get("data", []), key=lambda d: d.get("index", 0))
    if len(data) != len(texts):
        raise RuntimeError("embedding response size mismatch")
    return [d.get("embedding", []) for d in data]


def _gemini(texts: list) -> list:
    key = os.environ["GEMINI_API_KEY"]
    base = os.environ.get("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
    models = [os.environ.get("GEMINI_EMBEDDING_MODEL", "text-embedding-004"), "text-embedding-004", "embedding-001"]
    model = next((m for m in models if m), "text-embedding-004")
    out = []
    for t in texts:
        r = requests.post(
            f"{base}/models/{model}:embedContent?key={key}",
            json={"content": {"parts": [{"text": t}]}},
            timeout=EMBED_TIMEOUT_S,
        )
        r.raise_for_status()
        out.append(r.json().get("embedding", {}).get("values", []))
    return out


def embed(texts: list) -> list:
    if not texts:
        return []
    if os.environ.get("GEMINI_API_KEY"):
        return _gemini(texts)
    if os.environ.get("OPENAI_API_KEY"):
        return _openai(texts)
    raise RuntimeError("No embedding provider configured (GEMINI_API_KEY / OPENAI_API_KEY)")
