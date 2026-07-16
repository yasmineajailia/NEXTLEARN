# RAG chatbot → Python migration plan

**Decision (agreed):** move the **full** RAG chatbot into the Python service — retrieval,
embeddings, doc extraction, grounding and generation — so Python owns all ML + AI compute
and JS keeps only web/orchestration. This is the largest single move in the migration;
this document is the plan to review **before** any code is written.

Status: **COMPLETE — all phases A–E done.** Predictions, SHAP, clustering, attention analytics
and quiz generation are shipped. The RAG chatbot is now **Python-only**: retrieval (ChromaDB) +
scope guards + LLM generation (buffered + SSE streaming) live in `ml/rag/`, served by
`/rag/answer` and `/rag/stream`. Node's `chatbot.ts` is a thin proxy (access control + forward
via `chatbot/ragClient.ts`). The JS engine (`chatbot/rag.ts`) and the `StudentChatbotVector`
Mongo model were **deleted** in Phase E; there is no JS RAG engine or fallback and no
`RAG_ENGINE` flag. The Chroma store persists on disk and is populated by `npm run reindex:rag`
(781 vectors over the 4 modules); a curriculum save fires a background reindex. Grounded
`vector+llm` answers verified live, buffered + streamed.

---

## 1. What exists today (JS)

| File | Lines | Responsibility |
|---|---|---|
| `src/services/chatbot/rag.ts` | 1076 | vector store build/cache, cosine retrieval, lexical fallback, grounding/scope guards, prompts, buffered + **SSE streaming** generation |
| `src/services/llm.ts` | 225 | embeddings (OpenAI + Gemini), Gemini model catalog, answer-text extraction |
| `src/services/courseContent.ts` | 336 | GridFS + filesystem course files, PDF/DOCX/PPTX extraction (cached) |
| `src/routes/student/chatbot.ts` | 263 | `/api/student/chatbot` (buffered) + `/api/student/chatbot/stream` (SSE), warm-up |
| `src/models/StudentChatbotVector.ts` | — | Mongo collection: `{ chunkId, moduleId, subAcquisId, kind, text, contentHash, embedding[] }` |

Pipeline: persisted modules → chunk → embed (external API) → store vectors in **Mongo** →
per-question: retrieve top-k by cosine (+ lexical fallback) → scope/grounding guards →
prompt → LLM (Gemini/OpenAI) buffered or streamed → grounded-answer check → refuse or answer.

---

## 2. Target architecture (Python)

```
Browser ──/api/student/chatbot[/stream]──▶ Node (thin proxy, auth, lang)
                                             │  POST /rag/answer  |  POST /rag/stream (SSE)
                                             ▼
                                    Python ML service (shap_service.py)
                                      rag/  index.py     build + refresh vectors
                                            retrieve.py  cosine + lexical fallback
                                            guards.py    scope + grounding + refusal
                                            generate.py  prompts + LLM buffered/stream
                                            content.py   GridFS + PDF/DOCX/PPTX extract
                                      ▼                 ▼
                                    MongoDB (pymongo)   OpenAI/Gemini (embeddings + chat)
                                    StudentChatbotVector + GridFS course files
```

Node keeps: the two HTTP routes (auth, `lang`, request shaping) and **proxies the SSE
stream** through to the browser (the browser never talks to Python directly — Python is
unauthenticated and localhost-only).

---

## 3. Key decisions

1. **Vector store — ChromaDB (decided).** A Chroma persistent collection (`student_rag`,
   cosine space) at `ml/rag/chroma_store/` (gitignored). Chosen over reusing the Mongo
   `StudentChatbotVector` collection because it's Python-native, purpose-built for vector
   search + metadata filtering, and keeps the RAG code clean. Embeddings are computed
   externally (decision #2) and passed in, so Chroma is storage + ANN only. The Mongo
   `StudentChatbotVector` collection becomes legacy and can be dropped after Phase E. Mongo
   is still the *source* for curriculum + GridFS course files (read in later phases; in
   Phase A, Node posts the modules to `/rag/reindex`).

2. **Embeddings — keep the external API (OpenAI/Gemini).**
   Port `llm.ts`' embedding calls to Python (`requests`). Same vectors, same dimensions, so
   existing stored embeddings stay valid. (Local `sentence-transformers` would re-embed
   everything and change dimensions — rejected for now.)

3. **Mongo access from Python — add `pymongo` + `MONGODB_URI`.**
   The service already loads `.env` (added for quiz gen). Add `pymongo` (+ GridFS) to
   `requirements.txt`. Python reads persisted curriculum + GridFS course files directly, so
   Node no longer has to pass module content.

4. **Doc extraction — move to Python** (`pypdf`, `python-docx`, `python-pptx`).
   Cleaner than the JS libs; cache extracted text in-process (and/or a Mongo cache collection
   keyed by `contentHash`).

5. **Streaming — FastAPI `StreamingResponse` (SSE); Node proxies.**
   Python emits `event:/data:` SSE; Node's `/stream` route pipes the upstream response body
   straight to the client, preserving the current browser contract (no frontend change).

6. **Secrets/keys — already solved.** Gemini/OpenAI keys reach Python via inherited env /
   `.env` (same mechanism quiz gen uses). Add `MONGODB_URI` read on the Python side.

---

## 4. Phased steps (each independently shippable + testable)

**Phase A — content + embeddings + Chroma index (no user-facing change). ✅ DONE.**
- `ml/rag/store.py`: ChromaDB persistent collection (upsert/query/count/reset, cosine).
- `ml/rag/content.py`: native PDF/DOCX/PPTX extraction (pypdf/python-docx/python-pptx) +
  fetch-from-URL + snippet splitting.
- `ml/rag/embed.py`: OpenAI/Gemini embeddings (port of `llm.ts`, same provider/model).
- `ml/rag/index.py`: chunk builder (1:1 port of `buildStudentRagIndex`, same chunk-id hash)
  → embed new chunks → upsert; dedups on chunk id.
- Endpoints `POST /rag/reindex`, `GET /rag/stats`.
- Tested in isolation: Chroma round-trip + where-filter, docx/pptx extraction, reindex +
  dedup (with an injected embedder, no external calls). Not yet wired to any Node route.

**Phase B — retrieval + guards in Python. ✅ DONE.**
- `ml/rag/retrieve.py` — vector (Chroma) + lexical retrieval, `score_chunk`, `refine_chunks`
  (1:1 port of getStudentVectorMatches / scoreStudentRagChunk / refineStudentRagChunks).
- `ml/rag/guards.py` — `normalize_for_lookup`, `tokenize`, `has_meaningful_grounding`,
  `is_outside_langage_c`, `is_ambiguous_programming` (1:1 port; refusal-answer checks land
  in Phase C with generation).
- Endpoint `POST /rag/retrieve` returns refined chunks + guard flags.
- **Parity verified**: a JS-vs-Python harness on a fixed question/chunk set produced
  byte-identical tokens, scope guards, grounding decisions, lexical scores and refine order.

**Phase C — generation (buffered) in Python. ✅ DONE.**
- `ml/rag/generate.py`: prompts (port of `buildStudentChatPrompts`, fr+en), LLM call
  (Gemini→OpenAI, temp 0.2, with history), grounded/refusal checks, deterministic fallback,
  and the `answer()` orchestrator (port of `buildStudentChatContext` + the generation block:
  retrieve → refine → scope-guard → generate → grounded check → fallback).
- Endpoint `POST /rag/answer`. Node client `src/services/chatbot/ragClient.ts`; the buffered
  `/api/student/chatbot` route switches to it when `RAG_ENGINE=python` (default JS), with
  Node still doing access control + passing the allowed ids.
- **Parity verified**: prompts (fr+en), deterministic answer, refusal detection and
  grounded-answer check are byte-identical JS vs Python. Scope-guard + deterministic paths
  tested live; the LLM path shares the verified prompts.

**Phase D — streaming in Python + Node proxy. ✅ DONE.**
- `POST /rag/stream` (FastAPI `StreamingResponse`, SSE) in Python (`generate.stream_answer`
  + `stream_generate`, a 1:1 port of `streamStudentChatAnswer`: OpenAI only, raw deltas, no
  grounding re-check, `+stream` mode, deterministic fallback). Node's
  `/api/student/chatbot/stream` does access control then proxies the frames verbatim
  (`ragClient.streamViaPython`), so the browser contract is unchanged.
- **Verified live**: in-scope question streamed 373 `delta` frames in the
  `meta -> delta* -> sources -> done` order with a grounded `vector+stream` answer; the
  scope-guard path emits `meta(scope-guard) -> delta -> sources[] -> done`.

**Phase E — delete the JS RAG. ✅ DONE.**
- Deleted `src/services/chatbot/rag.ts` and `src/models/StudentChatbotVector.ts`.
- `chatbot.ts` trimmed to a thin proxy; `ragClient.ts` is the sole RAG client (also holds
  `normalizeChatHistory` + the `StudentChatTurn` type, and `requestPythonReindex`). The
  `RAG_ENGINE` flag is gone — Python is the only path.
- `server.ts` boot warm-up removed (Chroma persists on disk). `web.ts`'s curriculum-save
  `invalidateStudentVectorStore()` → fire-and-forget `requestPythonReindex()`.
- **Deleted** `llm.ts` too: once the JS RAG engine and the dead remediation-quiz generator
  were gone, nothing imported it (embeddings + chat now live in `ml/rag/embed.py` +
  `ml/quizgen.py`).
- **Kept** `courseContent.ts` and `mammoth`/`pdf-parse`/`jszip`/`pdfjs-dist`: still used by
  `web.ts` (GridFS media plumbing, quiz `.docx` extraction, curriculum seeding) — not
  RAG-only, so they stay. The legacy Mongo `studentchatbotvectors` collection can be dropped
  whenever (orphaned data, harmless).

---

## 5. Testing

- **Parity harnesses** at each phase: same inputs to JS and Python, diff outputs
  (chunk ids, top-k order, grounded/refused decision, answer text similarity).
- Fixed question set covering: in-scope C questions, out-of-scope (must refuse),
  ambiguous, and no-grounding cases.
- Streaming smoke test through Node → browser contract unchanged.
- Isolated-port testing throughout (never disturb the running `:3000`/`:8000`).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Streaming regressions (the fiddliest part) | Phase D last, behind a flag; keep JS stream until verified |
| Grounding/scope-guard drift changes what the bot refuses | Port thresholds 1:1; parity-diff the decisions before switching |
| Python service becomes heavy (Mongo + docs + LLM) | It's already supervised; consider a **separate** Python process/port for RAG if startup/memory grows |
| Embedding dimension mismatch invalidates stored vectors | Keep the same embedding provider/model; don't re-embed |
| New deps (`pymongo`, `pypdf`, `python-docx`, `python-pptx`) | Pin in `requirements.txt`; `npm run shap:install` covers them |

## 7. Rollback

Each phase leaves the JS path intact until its Python replacement is parity-verified; the
Node routes switch via a single flag, so reverting is a config change, not a redeploy.

---

## 8. Rough effort

Much larger than the prior moves (~1,900 lines + streaming + Mongo/GridFS + doc extraction).
Estimate **5 focused work sessions**, one per phase, with parity checks gating each. Do not
attempt in a single pass — Phase D (streaming) is where regressions hide.
