"""
answer_gap.py — semantic gap analysis for "explain it in your own words".

The student writes a free-text explanation of the lesson they just studied; we
compare it against the lesson's OWN indexed content (the Chroma chunks for that
sous-acquis) and report which key concepts their explanation covers and which
are missing. The reference is the course content itself, so no teacher-authored
answer key is needed.

Method
  1. Pull the sous-acquis chunks from the store and extract key concept
     sentences (deduped, capped).
  2. Embed the student's sentences + the concept sentences in one batch
     (same providers as the RAG index, embed.py).
  3. A concept is "covered" when its best cosine similarity against any student
     sentence (or the whole answer) clears COVER_THRESHOLD.
  4. Score = % of concepts covered; the missing concepts come back verbatim so
     the UI can show exactly what to revise.

When no embedding provider is configured we fall back to lexical token-overlap
coverage, so the feature degrades instead of disappearing.
"""

import hashlib
import json
import os
import re
import threading

from . import embed as embedder
from . import generate as generation
from . import nli
from . import store
from .guards import normalize_for_lookup, normalize_whitespace, tokenize

# Chunk kinds that describe the lesson itself (not quizzes/videos metadata).
CONTENT_KINDS = {"course-content", "sub-acquis", "course-file"}

MAX_CONCEPTS = 10          # reference concepts compared per analysis
MAX_STUDENT_SENTENCES = 12
MIN_CONCEPT_WORDS = 5      # too short to be a standalone concept
MAX_CONCEPT_WORDS = 45     # too long — split failed, skip
MIN_ANSWER_WORDS = 8       # below this the answer can't be judged fairly
COVER_THRESHOLD = float(os.environ.get("ANSWER_GAP_COVER_THRESHOLD", "0.5"))
LEXICAL_COVER_THRESHOLD = 0.6  # fraction of concept tokens present in the answer

# NLI verification thresholds (P(entailment) of "this text explains {concept}").
# A similarity candidate is DEMOTED when entailment is very low (mention without
# explanation / contradiction); a non-candidate is RESCUED by high entailment
# (paraphrase or cross-lingual answer the bi-encoder underscored).
NLI_SUPPORT = float(os.environ.get("ANSWER_GAP_NLI_SUPPORT", "0.3"))
NLI_RESCUE = float(os.environ.get("ANSWER_GAP_NLI_RESCUE", "0.75"))

_SENTENCE_SPLIT = re.compile(r"[.!?;\n•●■\-–—]+\s*")
# Code fragments and slide scaffolding are not "concepts" a student should
# paraphrase: C tokens, braces, comment markers, printf/scanf calls, etc.
_CODE_MARKERS = re.compile(
    r"//|/\*|[{}<>=]|\b(printf|scanf|include|int main|void|return|while\s*\(|for\s*\(|if\s*\()", re.IGNORECASE
)
_LEADING_SLIDE_NUM = re.compile(r"^[\s\d():.,\-]+")
_DIGITS = re.compile(r"\d+")


def _sentences(text: str) -> list:
    """Split text into candidate sentences on punctuation/newlines/bullets."""
    parts = _SENTENCE_SPLIT.split(text or "")
    return [normalize_whitespace(p) for p in parts if p and p.strip()]


def _is_prose(sent: str) -> bool:
    """Keep only natural-language sentences: no code fragments, and mostly
    alphabetic words (slide scaffolding is number/symbol-heavy)."""
    if _CODE_MARKERS.search(sent):
        return False
    words = sent.split()
    alpha = sum(1 for w in words if any(ch.isalpha() for ch in w))
    return alpha >= max(MIN_CONCEPT_WORDS - 1, int(0.7 * len(words)))


def _key_concepts(chunks: list) -> list:
    """Concept sentences from the lesson's content chunks: slide headers that
    just repeat the lesson/module title are dropped, enumeration prefixes and
    the module-name prefix are stripped, and near-duplicates are deduped
    ignoring digits (slide "builds" repeat the same header with a new page
    number). Capped at MAX_CONCEPTS."""
    module_name = ""
    sub_name = ""
    for chunk in chunks:
        module_name = module_name or str(chunk.get("moduleName") or "")
        sub_name = sub_name or str(chunk.get("subAcquisName") or "")
    module_prefix = re.compile(r"^" + re.escape(module_name) + r"\s*", re.IGNORECASE) if module_name else None
    # Digit-free normalized title, to recognize header lines like
    # "1): 4 Etapes de résolution d'un problème".
    sub_norm = _DIGITS.sub("", normalize_for_lookup(sub_name)).strip() if sub_name else ""

    concepts: list = []
    concepts_norm: list = []
    for chunk in chunks:
        if chunk.get("kind") not in CONTENT_KINDS:
            continue
        for sent in _sentences(chunk.get("text") or ""):
            sent = _LEADING_SLIDE_NUM.sub("", sent)          # "1): 4 " enumeration junk
            if module_prefix:
                sent = module_prefix.sub("", sent).strip()   # "Programmation en C ..." header glue
            words = sent.split()
            if not (MIN_CONCEPT_WORDS <= len(words) <= MAX_CONCEPT_WORDS):
                continue
            if not _is_prose(sent):
                continue
            ns = _DIGITS.sub("", normalize_for_lookup(sent)).strip()
            if not ns:
                continue
            # Slide header = the lesson title itself (give or take digits).
            if sub_norm and (ns in sub_norm or sub_norm in ns):
                continue
            if any(ns in kept or kept in ns for kept in concepts_norm):
                continue
            concepts.append(sent.strip(" .,;:*-"))
            concepts_norm.append(ns)
            if len(concepts) >= MAX_CONCEPTS:
                return concepts
    return concepts


# ── LLM concept distillation (preferred over raw sentence extraction) ──────
# Slide text is bullet debris — raw sentences make poor "notions to review".
# Instead we ask the chat LLM ONCE per lesson to distill clean, short notion
# titles from the content, and cache them keyed on the lesson's content hashes
# (an edited lesson re-distills automatically). The cache is PERSISTED to disk
# so a lesson's notions are stable across service restarts — the same student
# answer must not score differently because the LLM re-distilled a different
# concept set. Falls back to sentence extraction when no LLM is configured or
# the call fails.
_CONCEPT_CACHE: dict = {}
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "concept_cache.json")
_cache_lock = threading.Lock()
_cache_loaded = False


def _load_cache():
    global _cache_loaded
    with _cache_lock:
        if _cache_loaded:
            return
        _cache_loaded = True
        try:
            with open(_CACHE_FILE, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                _CONCEPT_CACHE.update({k: v for k, v in data.items() if isinstance(v, list)})
        except (OSError, ValueError):
            pass  # no cache yet / corrupt -> start empty


def _save_cache():
    with _cache_lock:
        try:
            with open(_CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(_CONCEPT_CACHE, f, ensure_ascii=False, indent=1)
        except OSError as exc:
            print(f"[answer-gap] concept cache not saved ({exc})")

_LLM_CONCEPTS_SYSTEM = (
    "Tu es un assistant pédagogique pour un cours de programmation en C. "
    "Tu extrais les notions clés d'un support de cours."
)
_LLM_CONCEPTS_USER = (
    "Contenu du cours (extraits de diapositives, potentiellement décousus) :\n\n{content}\n\n"
    "Liste les notions clés qu'un étudiant devrait mentionner s'il expliquait cette leçon avec ses propres mots. "
    "Réponds UNIQUEMENT avec un tableau JSON de 4 à 8 chaînes {language}. "
    "Chaque notion est une expression descriptive complète et autonome (4 à 12 mots), "
    "sans numérotation ni ponctuation finale — pas de fragments de deux mots. "
    "Exemple de format : {example}"
)
_LLM_LANG = {
    "fr": ("en français", "[\"Les étapes de résolution d'un problème\", \"La compilation du code source en exécutable\"]"),
    "en": ("en ANGLAIS (l'étudiant utilise l'interface anglaise)", "[\"The steps for solving a problem\", \"Compiling the source code into an executable\"]"),
}


def _cache_key(module_id: str, sub_id: str, chunks: list, lang: str) -> str:
    hashes = sorted(
        str(c.get("contentHash") or "") + (c.get("text") or "")[:40]
        for c in chunks
        if c.get("kind") in CONTENT_KINDS
    )
    # Stable content hash (NOT builtin hash(), which is salted per process) so
    # the persisted cache survives restarts.
    digest = hashlib.sha1("\n".join(hashes).encode("utf-8")).hexdigest()[:16]
    return f"{module_id}::{sub_id}::{lang}::{digest}"


def _parse_concept_json(raw: str) -> list:
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)  # strip code fences
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return []
    out = []
    for item in data if isinstance(data, list) else []:
        s = normalize_whitespace(str(item)).strip(" .,;:*-")
        if 3 <= len(s) <= 90:
            out.append(s)
    return out[:MAX_CONCEPTS]


def _llm_concepts(module_id: str, sub_id: str, chunks: list, lang: str = "fr") -> list:
    """Distilled notion titles for a lesson, LLM-generated and cached per
    (lesson content, language) — an English-interface student sees English
    notion titles. Returns [] when no LLM is configured or the response is
    unusable (caller falls back to sentence extraction; failures are NOT
    cached so a flaky call can succeed next time)."""
    if not (os.environ.get("OPENAI_API_KEY") or os.environ.get("GEMINI_API_KEY")):
        return []
    _load_cache()
    key = _cache_key(module_id, sub_id, chunks, lang)
    if key in _CONCEPT_CACHE:
        return _CONCEPT_CACHE[key]

    content = "\n".join(
        normalize_whitespace(c.get("text") or "")
        for c in chunks
        if c.get("kind") in CONTENT_KINDS
    )[:7000]
    if not content.strip():
        return []
    language, example = _LLM_LANG.get(lang, _LLM_LANG["fr"])
    user = _LLM_CONCEPTS_USER.format(content=content, language=language, example=example)

    # Two attempts across the provider chain — a single flaky call otherwise
    # silently degrades this lesson to raw sentence extraction.
    for attempt in (1, 2):
        raw = ""
        try:
            if os.environ.get("GEMINI_API_KEY"):
                raw = generation._gemini(_LLM_CONCEPTS_SYSTEM, user, [])
            if not raw and os.environ.get("OPENAI_API_KEY"):
                raw = generation._openai(_LLM_CONCEPTS_SYSTEM, user, [])
        except Exception as exc:  # noqa: BLE001 — LLM down -> sentence fallback
            print(f"[answer-gap] LLM concept distillation failed (attempt {attempt}, {type(exc).__name__}: {exc})")
            continue
        concepts = _parse_concept_json(raw)
        if len(concepts) >= 3:
            _CONCEPT_CACHE[key] = concepts
            _save_cache()
            return concepts
    return []


def _cosine(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na < 1e-9 or nb < 1e-9:
        return 0.0
    return dot / (na * nb)


def _band(score: int) -> str:
    if score >= 70:
        return "acquired"
    if score >= 40:
        return "partial"
    return "gap"


def _embedding_coverage(student_text: str, concepts: list) -> list:
    """Best cosine similarity of each concept against the student's sentences
    and the whole answer. One embedding batch for everything."""
    student_units = _sentences(student_text)[:MAX_STUDENT_SENTENCES]
    if student_text not in student_units:
        student_units.append(student_text)  # whole answer as one more unit
    vectors = embedder.embed(student_units + concepts)
    student_vecs = vectors[: len(student_units)]
    concept_vecs = vectors[len(student_units):]
    sims = []
    for cv in concept_vecs:
        sims.append(max((_cosine(sv, cv) for sv in student_vecs), default=0.0))
    return sims


def _lexical_coverage(student_text: str, concepts: list) -> list:
    """Fallback coverage without embeddings: fraction of each concept's tokens
    present in the student's answer, mapped onto the same 0..1 scale so the
    threshold logic stays shared."""
    student_tokens = set(tokenize(student_text))
    sims = []
    for concept in concepts:
        ct = tokenize(concept)
        if not ct:
            sims.append(0.0)
            continue
        overlap = sum(1 for t in ct if t in student_tokens) / len(ct)
        # Rescale so LEXICAL_COVER_THRESHOLD lands on COVER_THRESHOLD.
        sims.append(overlap * (COVER_THRESHOLD / LEXICAL_COVER_THRESHOLD))
    return sims


def analyze(module_id: str, sub_id: str, student_text: str, lang: str = "fr") -> dict:
    """Compare a student's free-text explanation to the lesson's indexed content.

    Returns {available, method, score, band, conceptCount, covered, missing}
    where covered/missing are the concept sentences themselves (for the UI),
    or {available: False, reason} when the analysis cannot run.
    """
    text = normalize_whitespace(student_text or "")
    if len(text.split()) < MIN_ANSWER_WORDS:
        return {"available": False, "reason": "too-short"}

    where = {"$and": [{"moduleId": module_id or ""}, {"subAcquisId": sub_id or ""}]}
    try:
        chunks = store.fetch(where=where)
    except Exception:  # noqa: BLE001 — store down/absent
        chunks = []
    # Preferred: clean LLM-distilled notion titles (cached per lesson+lang);
    # fallback: raw sentence extraction from the slides.
    concepts = _llm_concepts(module_id, sub_id, chunks, lang) or _key_concepts(chunks)
    if not concepts:
        return {"available": False, "reason": "no-content"}

    # Stage 1 — retrieval: semantic similarity per concept (bi-encoder).
    method = "embedding"
    try:
        if not embedder.has_provider():
            raise RuntimeError("no embedding provider")
        sims = _embedding_coverage(text, concepts)
    except Exception as exc:  # noqa: BLE001 — provider down -> lexical degradation
        # Lexical coverage is MUCH stricter (exact words); log the reason so a
        # misconfigured/failing provider doesn't silently degrade feedback.
        print(f"[answer-gap] embedding path failed ({type(exc).__name__}: {exc}) — lexical fallback")
        method = "lexical"
        sims = _lexical_coverage(text, concepts)

    # Stage 2 — verification: cross-encoder entailment ("does the text EXPLAIN
    # the concept?"). Demotes mere mentions/contradictions the bi-encoder
    # scored high; rescues paraphrases and cross-lingual answers it underscored.
    # Colon form stays grammatical whether the concept is a noun phrase
    # ("la compilation") or a verb phrase ("déterminer les formules").
    # Deliberately asserts EXPLANATION, not mere mention: "ce texte aborde X"
    # is entailed by "je ne comprends pas X" — "explique en détail" is not.
    template = "This text explains in detail: {}." if lang == "en" else "Ce texte explique en détail : {}."
    entails = nli.entail_probs(text, [template.format(c) for c in concepts])
    if entails is not None:
        method += "+nli"
        flags = [
            (s >= COVER_THRESHOLD and e >= NLI_SUPPORT) or e >= NLI_RESCUE
            for s, e in zip(sims, entails)
        ]
    else:
        flags = [s >= COVER_THRESHOLD for s in sims]

    covered = [c for c, f in zip(concepts, flags) if f]
    # Weakest first so the UI shows the most-missing concepts on top.
    strength = entails if entails is not None else sims
    missing = [c for _, c in sorted((st, c) for c, f, st in zip(concepts, flags, strength) if not f)]
    score = round(100 * len(covered) / len(concepts))

    return {
        "available": True,
        "method": method,
        "score": score,
        "band": _band(score),
        "conceptCount": len(concepts),
        "covered": covered,
        "missing": missing,
        # Per-concept diagnostics: benchmarkable + explainable (defense demo).
        "details": [
            {
                "concept": c,
                "similarity": round(s, 3),
                "entailment": round(e, 3) if entails is not None else None,
                "covered": f,
            }
            for c, s, e, f in zip(
                concepts, sims, entails if entails is not None else [0.0] * len(concepts), flags
            )
        ],
    }
