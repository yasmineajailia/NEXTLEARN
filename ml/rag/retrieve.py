"""
retrieve.py — student RAG retrieval, ported from getStudentVectorMatches +
scoreStudentRagChunk + refineStudentRagChunks in rag.ts.

- Vector path: embed the question, ANN search in Chroma, filter to the learner's
  allowed modules/sub-acquis.
- Lexical path: token-overlap scoring (used for the sub-acquis-scoped chatbot,
  and as the fallback when the vector store/embeddings are unavailable).

Chunk dicts here carry the same fields as StudentRagChunk plus `tokens`.
"""

from . import embed as embedder
from . import store
from .guards import normalize_for_lookup, tokenize

KIND_WEIGHT = {"sub-acquis": 1.6, "course-content": 1.5, "quiz": 1.4, "module": 1.2}


def with_tokens(chunk: dict) -> dict:
    out = dict(chunk)
    out["tokens"] = tokenize(chunk.get("text") or "")
    return out


def score_chunk(chunk: dict, query_normalized: str, query_tokens: list) -> float:
    if not query_tokens:
        return 0.0
    chunk_set = set(chunk.get("tokens") or [])
    overlap = sum(1 for t in query_tokens if t in chunk_set)
    if overlap == 0:
        return 0.0
    exact_boost = 2 if query_normalized in normalize_for_lookup(chunk.get("text") or "") else 0
    kind_weight = KIND_WEIGHT.get(chunk.get("kind"), 1.0)
    coverage = overlap / max(1, len(query_tokens))
    return coverage * 8 * kind_weight + overlap + exact_boost


def refine_chunks(question: str, chunks: list) -> list:
    if not chunks:
        return []
    normalized = normalize_for_lookup(question)
    asks_quiz = any(k in normalized for k in ("quiz", "question", "qcm", "exercice"))
    asks_video = "video" in normalized or "vidéo" in normalized

    if asks_quiz:
        order = ["quiz", "course-content", "sub-acquis", "module", "course-file", "video"]
    elif asks_video:
        order = ["video", "course-content", "sub-acquis", "module", "course-file", "quiz"]
    else:
        order = ["course-content", "sub-acquis", "module", "course-file", "video", "quiz"]
    rank = {kind: i for i, kind in enumerate(order)}

    by_pref = sorted(chunks, key=lambda c: rank.get(c.get("kind"), -1))

    seen, refined = set(), []
    for chunk in by_pref:
        key = (
            f"{chunk.get('moduleId')}::{chunk.get('subAcquisId')}"
            if chunk.get("subAcquisId")
            else f"{chunk.get('moduleId')}::module"
        )
        if key in seen:
            continue
        if not asks_quiz and chunk.get("kind") == "quiz":
            continue
        refined.append(chunk)
        seen.add(key)
        if len(refined) >= 5:
            break
    return refined or chunks[:5]


def _allowed(chunk: dict, allowed_modules: set, allowed_subacquis: set) -> bool:
    if chunk.get("moduleId") not in allowed_modules:
        return False
    sub = chunk.get("subAcquisId")
    if not sub:
        return True
    return f"{chunk.get('moduleId')}::{sub}" in allowed_subacquis


def lexical_retrieve(chunks: list, question: str, boost_sub: str | None = None, limit: int = 6) -> list:
    qn = normalize_for_lookup(question)
    qt = tokenize(question)
    scored = []
    for c in chunks:
        s = score_chunk(c, qn, qt)
        if boost_sub and c.get("subAcquisId") == boost_sub:
            s *= 1.15
        if s > 0:
            scored.append((s, c))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored[:limit]]


def retrieve(
    question: str,
    allowed_module_ids: list,
    allowed_subacquis_ids: list,
    filter_module: str | None = None,
    filter_sub: str | None = None,
    k: int = 6,
) -> list:
    allowed_modules = set(allowed_module_ids or [])
    allowed_subacquis = set(allowed_subacquis_ids or [])

    if filter_module:
        allowed_modules = {filter_module}
        allowed_subacquis = {x for x in allowed_subacquis if x.startswith(f"{filter_module}::")}

    # Sub-acquis-scoped chatbot: lexical over the whole module (skips embeddings).
    if filter_module and filter_sub:
        chunks = [with_tokens(c) for c in store.fetch(where={"moduleId": filter_module})]
        chunks = [c for c in chunks if _allowed(c, allowed_modules, allowed_subacquis)]
        return lexical_retrieve(chunks, question, boost_sub=filter_sub)

    # Vector retrieval with a lexical fallback.
    try:
        emb = embedder.embed([question])[0]
        where = {"moduleId": {"$in": list(allowed_modules)}} if allowed_modules else None
        hits = store.query(emb, k=max(k * 2, k), where=where)
        chunks = []
        for h in hits:
            m = h.get("metadata") or {}
            c = {
                "chunkId": h.get("chunkId"),
                "text": h.get("text") or "",
                "moduleId": m.get("moduleId") or "",
                "moduleName": m.get("moduleName") or "",
                "subAcquisId": m.get("subAcquisId") or None,
                "subAcquisName": m.get("subAcquisName") or None,
                "kind": m.get("kind") or "",
            }
            if _allowed(c, allowed_modules, allowed_subacquis):
                chunks.append(with_tokens(c))
        return chunks[:k]
    except Exception:  # noqa: BLE001 — embeddings/store down -> lexical fallback
        allc = [
            with_tokens(c)
            for c in store.fetch()
            if _allowed(c, allowed_modules, allowed_subacquis)
        ]
        return lexical_retrieve(allc, question)
