"""
guards.py — deterministic text helpers + scope/grounding guards for the student
RAG, ported 1:1 from src/services/chatbot/rag.ts (and textNormalize.ts). Same
stopwords, same thresholds, same refusal logic — verified against the JS by the
parity harness so retrieval/scope behaviour doesn't drift in the migration.
"""

import re
import unicodedata

STOPWORDS = {
    "le", "la", "les", "de", "des", "du", "un", "une", "et", "ou", "dans", "sur",
    "pour", "avec", "que", "qui", "quoi", "est", "sous", "acquis", "module",
}


def normalize_for_lookup(value: str) -> str:
    """NFD, strip combining diacritics, lowercase (matches textNormalize.ts)."""
    decomposed = unicodedata.normalize("NFD", value or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return stripped.lower()


def normalize_whitespace(value: str) -> str:
    """Collapse runs of whitespace to a single space and trim (matches textNormalize.ts)."""
    return re.sub(r"\s+", " ", value or "").strip()


def tokenize(value: str) -> list:
    normalized = normalize_for_lookup(value)
    return [
        tok
        for tok in (t.strip() for t in re.split(r"[^a-z0-9]+", normalized))
        if len(tok) >= 2 and tok not in STOPWORDS
    ]


def has_meaningful_grounding(question: str, chunks: list) -> bool:
    if not chunks:
        return False
    question_tokens = tokenize(question)
    if not question_tokens:
        return False
    unique = set(question_tokens)
    max_overlap = 0
    for chunk in chunks:
        chunk_set = set(chunk.get("tokens") or [])
        overlap = sum(1 for t in unique if t in chunk_set)
        if overlap > max_overlap:
            max_overlap = overlap
    coverage = max_overlap / max(1, len(unique))
    return max_overlap >= 2 or coverage >= 0.35


def is_outside_langage_c(question: str) -> bool:
    normalized = normalize_for_lookup(question)
    mentions_other = any(
        lang in normalized
        for lang in ("python", "javascript", "java", "php", "ruby", "c++", "csharp", "c#")
    )
    if not mentions_other:
        return False
    return (
        "langage c" not in normalized
        and " en c" not in normalized
        and " langage c " not in normalized
    )


def is_ambiguous_programming(question: str) -> bool:
    normalized = normalize_for_lookup(question)
    asks_coding = any(
        p in normalized for p in ("boucle", "for", "while", "if", "fonction", "variable")
    )
    if not asks_coding:
        return False
    explicitly_scoped = (
        "langage c" in normalized or " en c" in normalized or "module" in normalized
    )
    return not explicitly_scoped
