"""
store.py — ChromaDB vector store for the student RAG index.

Replaces the Mongo `StudentChatbotVector` collection with a Chroma persistent
collection (cosine space). Embeddings are computed externally (embed.py) and
passed in — Chroma just stores + does nearest-neighbour search.

The store lives on disk at RAG_CHROMA_PATH (default ml/rag/chroma_store), so it
survives restarts. Tests point RAG_CHROMA_PATH at a temp dir.
"""

import os

import chromadb
from chromadb.config import Settings

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTION = "student_rag"

_collection = None


def _store_path() -> str:
    return os.environ.get("RAG_CHROMA_PATH", os.path.join(HERE, "chroma_store"))


def _coll():
    global _collection
    if _collection is None:
        client = chromadb.PersistentClient(
            path=_store_path(), settings=Settings(anonymized_telemetry=False)
        )
        _collection = client.get_or_create_collection(
            name=COLLECTION, metadata={"hnsw:space": "cosine"}
        )
    return _collection


def _meta(c: dict) -> dict:
    # Chroma metadata values must be str/int/float/bool — never None.
    return {
        "moduleId": c.get("moduleId") or "",
        "moduleName": c.get("moduleName") or "",
        "subAcquisId": c.get("subAcquisId") or "",
        "subAcquisName": c.get("subAcquisName") or "",
        "kind": c.get("kind") or "",
        "contentHash": c.get("contentHash") or "",
    }


def upsert(chunks: list) -> int:
    """chunks: dicts with chunkId, embedding, text + metadata fields."""
    rows = [c for c in chunks if c.get("embedding")]
    if not rows:
        return 0
    _coll().upsert(
        ids=[c["chunkId"] for c in rows],
        embeddings=[c["embedding"] for c in rows],
        documents=[c["text"] for c in rows],
        metadatas=[_meta(c) for c in rows],
    )
    return len(rows)


def query(embedding: list, k: int = 8, where: dict | None = None) -> list:
    res = _coll().query(
        query_embeddings=[embedding],
        n_results=k,
        where=where or None,
        include=["documents", "metadatas", "distances"],
    )
    ids = (res.get("ids") or [[]])[0]
    docs = (res.get("documents") or [[]])[0]
    metas = (res.get("metadatas") or [[]])[0]
    dists = (res.get("distances") or [[]])[0]
    out = []
    for i in range(len(ids)):
        out.append({
            "chunkId": ids[i],
            "text": docs[i],
            "metadata": metas[i] or {},
            "score": 1.0 - float(dists[i]),  # cosine distance -> similarity
        })
    return out


def fetch(where: dict | None = None) -> list:
    """All stored chunks (optionally filtered) as dicts — for lexical retrieval."""
    got = _coll().get(where=where or None, include=["documents", "metadatas"])
    ids = got.get("ids") or []
    docs = got.get("documents") or []
    metas = got.get("metadatas") or []
    out = []
    for i in range(len(ids)):
        m = metas[i] or {}
        out.append({
            "chunkId": ids[i],
            "text": docs[i],
            "moduleId": m.get("moduleId") or "",
            "moduleName": m.get("moduleName") or "",
            "subAcquisId": m.get("subAcquisId") or None,
            "subAcquisName": m.get("subAcquisName") or None,
            "kind": m.get("kind") or "",
        })
    return out


def existing_ids() -> set:
    """All chunk ids already stored. A chunkId encodes the text (see index.py),
    so 'id present' means 'identical text already embedded' — used for dedup."""
    got = _coll().get(include=[])
    return set(got.get("ids") or [])


def delete(ids: list) -> None:
    """Removes chunks by id (e.g. ones orphaned by an edited/deleted lesson —
    see index.reindex). No-op on an empty list; Chroma errors on an empty ids=[]."""
    if ids:
        _coll().delete(ids=list(ids))


def count() -> int:
    return _coll().count()


def reset():
    """Drop and recreate the collection (full rebuild)."""
    global _collection
    client = chromadb.PersistentClient(
        path=_store_path(), settings=Settings(anonymized_telemetry=False)
    )
    try:
        client.delete_collection(COLLECTION)
    except Exception:  # noqa: BLE001 — absent collection is fine
        pass
    _collection = None
    return _coll()
