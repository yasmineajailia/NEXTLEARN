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
from .guards import normalize_for_lookup, normalize_whitespace, tokenize

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
    # Tiny length tiebreak (<= ~1.0, always smaller than one extra token match):
    # when several chunks tie on relevance — e.g. slide "builds" of the same
    # content that repeat the intro with one more bullet each — prefer the most
    # complete one so the model actually receives the full list, not a stub.
    completeness = min(len(chunk_set), 50) / 50
    return coverage * 8 * kind_weight + overlap + exact_boost + completeness


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

    # Stable sort keeps the incoming relevance order (score, incl. the completeness
    # tiebreak) within a kind, so the fullest chunk leads among ties.
    by_pref = sorted(chunks, key=lambda c: rank.get(c.get("kind"), -1))

    # De-duplicate by CONTENT, not by sub-acquis id. Course slides are ingested as
    # progressive "builds" (the same passage with one more bullet each); collapsing
    # them by sub-acquis would drop everything but one stub. Instead we drop only a
    # chunk whose text is contained in a chunk we already kept (and let a more
    # complete chunk supersede a shorter one), so a single sub-acquis can still
    # contribute several *distinct* passages — the steps list AND their details.
    refined: list = []
    refined_norm: list = []
    for chunk in by_pref:
        if not asks_quiz and chunk.get("kind") == "quiz":
            continue
        ntext = normalize_whitespace(normalize_for_lookup(chunk.get("text") or ""))
        if not ntext:
            continue
        superseded = False
        for i, kept in enumerate(refined_norm):
            if ntext in kept:            # already covered by a fuller chunk
                superseded = True
                break
            if kept in ntext:            # this chunk is the fuller version
                refined[i] = chunk
                refined_norm[i] = ntext
                superseded = True
                break
        if superseded:
            continue
        refined.append(chunk)
        refined_norm.append(ntext)

    return refined[:5] or chunks[:5]


def _allowed(chunk: dict, allowed_modules: set, allowed_subacquis: set) -> bool:
    if chunk.get("moduleId") not in allowed_modules:
        return False
    sub = chunk.get("subAcquisId")
    if not sub:
        return True
    return f"{chunk.get('moduleId')}::{sub}" in allowed_subacquis


def find_locked_topic_match(
    question: str,
    filter_module: str | None,
    allowed_modules: set,
    allowed_subacquis: set,
    calendar_allowed_modules: set | None = None,
    calendar_allowed_subacquis: set | None = None,
) -> dict | None:
    """Searches indexed content — ignoring access restrictions — for a chunk
    genuinely on-topic for `question`, using the same token-overlap bar as
    has_meaningful_grounding (overlap >= 2 or coverage >= 0.35) rather than a
    new ad-hoc threshold. If the best such match falls OUTSIDE the caller's
    allowed scope (`allowed_modules`/`allowed_subacquis` — class access ∩
    progress frontier), returns its module/sous-acquis so the chatbot can say
    "that part of the course isn't available yet" instead of a vague "I don't
    have that information" — but only for a real, on-topic hit, not incidental
    keyword overlap, and only when it's actually outside scope (an allowed
    match just answers normally through the regular retrieval path).

    When `filter_module` is set (the chatbot is scoped to one lesson page), the
    search is narrowed to that module's content only. When it's None (the
    general, unscoped chatbot), the WHOLE indexed course is searched — this is
    the only way that assistant can recognize "pointeurs" as a real, just-locked
    topic instead of falling through to the vector/lexical fallback, which has
    no such concept and can only cite whatever it's allowed to see (occasionally
    matching on an unrelated shared word, e.g. "utiliser" across many acquis
    titles).

    `reason` in the result distinguishes two different situations a caller must
    word differently: "calendar" (genuinely locked by the schedule — telling the
    student to check their calendar is correct) vs. "progress" (already
    calendar-unlocked, just not yet reached by this student — telling them to
    check the calendar would be wrong, since the calendar already shows it as
    available). Determined by checking the match against the CALENDAR-only
    scope (no progress-frontier restriction); when that isn't supplied, this
    can't distinguish the two and defaults to "calendar" as the safer wording.
    """
    question_tokens = tokenize(question)
    if not question_tokens:
        return None
    unique = set(question_tokens)
    query_normalized = normalize_for_lookup(question)

    where = {"moduleId": filter_module} if filter_module else None
    all_chunks = store.fetch(where=where)
    # Rank with the same weighted score_chunk() used for real retrieval, not raw
    # overlap: several quiz items across the whole course share the exact same
    # question template ("Quand utiliser X plutôt que Y ?"), so "quand"/"utiliser"
    # alone can tie a genuinely on-topic chunk's overlap count on pure coincidence
    # — kind_weight (sub-acquis/course-content > quiz) and the exact-substring
    # boost break that tie in favor of real content instead of boilerplate.
    best_chunk = None
    best_score = 0.0
    best_overlap = 0
    for chunk in all_chunks:
        scored = with_tokens(chunk)
        overlap = sum(1 for t in unique if t in set(scored["tokens"]))
        if overlap == 0:
            continue
        score = score_chunk(scored, query_normalized, question_tokens)
        if score > best_score:
            best_score = score
            best_chunk = chunk
            best_overlap = overlap

    if not best_chunk:
        return None
    coverage = best_overlap / max(1, len(unique))
    if not (best_overlap >= 2 or coverage >= 0.35):
        return None
    if _allowed(best_chunk, allowed_modules, allowed_subacquis):
        return None

    reason = "calendar"
    if calendar_allowed_modules is not None and calendar_allowed_subacquis is not None:
        if _allowed(best_chunk, calendar_allowed_modules, calendar_allowed_subacquis):
            reason = "progress"

    return {
        "moduleId": best_chunk.get("moduleId"),
        "subAcquisId": best_chunk.get("subAcquisId"),
        "subAcquisName": best_chunk.get("subAcquisName"),
        "reason": reason,
    }


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
