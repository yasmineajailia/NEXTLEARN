"""
index.py — build the student RAG index and upsert it into Chroma.

Chunking mirrors the old JS buildStudentRagIndex 1:1 (same kinds, same text
templates, same chunk-id hashing) so the vectors are comparable across the
migration. The chunk id is a sha256 of moduleId|subKey|kind|text — because it
encodes the text, an id already present in the store means identical text is
already embedded, which is how we dedup / skip re-embedding unchanged chunks.

Node posts the persisted curriculum modules (structure + course-file URLs); this
module fetches + extracts the files (content.py), embeds new chunks (embed.py),
and upserts them (store.py). Keeps the engine pure w.r.t. the database.
"""

import hashlib

from . import content
from . import embed as embedder
from . import store


def _hash(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def _chunk_id(module_id: str, sub_id, kind: str, text: str) -> str:
    sub_key = sub_id or "module"
    return _hash(f"{module_id}|{sub_key}|{kind}|{text}")


def build_chunks(modules: list, base_url: str = "") -> list:
    """modules: persisted curriculum — [{id, name, acquis:[{sousAcquis:[...]}]}]."""
    chunks = []

    def add(mid, mname, sid, sname, kind, text):
        chunks.append({
            "chunkId": _chunk_id(mid, sid, kind, text),
            "moduleId": mid,
            "moduleName": mname,
            "subAcquisId": sid,
            "subAcquisName": sname,
            "kind": kind,
            "text": text,
            "contentHash": _hash(text),
        })

    for m in modules or []:
        mid = str(m.get("id") or "")
        mname = str(m.get("name") or mid)
        add(mid, mname, None, None, "module", f"Module {mid}: {mname}")

        for acq in m.get("acquis") or []:
            for sa in acq.get("sousAcquis") or []:
                sid = str(sa.get("id") or "")
                sname = str(sa.get("name") or sid)
                add(mid, mname, sid, sname, "sub-acquis", f"{mid}.{sid} {mname} {sname}")

                prompts = [
                    str(q.get("prompt") or "").strip()
                    for quiz in (sa.get("quizzes") or [])
                    for q in (quiz.get("questions") or [])
                    if q.get("prompt")
                ]
                for prompt in prompts[:4]:
                    add(mid, mname, sid, sname, "quiz", f"Quiz {sid}: {prompt}")

                for video in (sa.get("videos") or [])[:3]:
                    add(mid, mname, sid, sname, "video", f"Video {sid}: {str(video.get('title') or '').strip()}")

                for f in (sa.get("courseFiles") or [])[:5]:
                    title = str(f.get("title") or f.get("id") or "").strip()
                    add(mid, mname, sid, sname, "course-file", f"Support {sid}: {title}")
                    for snip in content.snippets_from_url(str(f.get("url") or ""), base_url)[:8]:
                        add(mid, mname, sid, sname, "course-content",
                            f"Contenu support {sid} ({title or 'support'}): {snip}")

    return chunks


def reindex(modules: list, base_url: str = "", reset: bool = False, embed_fn=None) -> dict:
    """Build chunks, embed only the ones not already in the store, and upsert."""
    if reset:
        store.reset()
    embed_fn = embed_fn or embedder.embed

    chunks = build_chunks(modules, base_url)
    existing = store.existing_ids()

    todo, seen = [], set()
    for c in chunks:
        cid = c["chunkId"]
        if cid in existing or cid in seen:
            continue
        seen.add(cid)
        todo.append(c)

    if todo:
        vectors = embed_fn([c["text"] for c in todo])
        for c, vec in zip(todo, vectors):
            c["embedding"] = vec
        store.upsert(todo)

    return {
        "totalChunks": len(chunks),
        "embedded": len(todo),
        "skipped": len(chunks) - len(todo),
        "storeCount": store.count(),
    }
