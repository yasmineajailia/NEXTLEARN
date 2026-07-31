"""
routers/rag_routes.py

Student chatbot RAG pipeline: vector store reindexing/stats, retrieval,
buffered + streaming answers, and the semantic answer-gap analysis endpoint.
Node does access control (allowed module/sous-acquis ids) before every call.
"""

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from rag import index as rag_index
from rag import retrieve as rag_retrieve
from rag import store as rag_store
from rag import guards as rag_guards
from rag import generate as rag_generate
from rag import answer_gap as rag_answer_gap

router = APIRouter()


class RagReindexBody(BaseModel):
    """Node posts the persisted curriculum modules; Python fetches course files,
    embeds new chunks and upserts them into the Chroma store."""
    modules: list[dict] = []
    baseUrl: str = ""
    reset: bool = False


class RagRetrieveBody(BaseModel):
    question: str = ""
    allowedModuleIds: list[str] = []
    allowedSubAcquisIds: list[str] = []
    filterToModuleId: str | None = None
    filterToSubAcquisId: str | None = None
    k: int = 6


class ChatTurn(BaseModel):
    role: str
    content: str


class LearnerProfile(BaseModel):
    """Derived, non-sensitive learner context used to personalize HOW the
    chatbot answers (tone/format/reinforcement) — never to invent facts."""
    name: str | None = None
    level: int | None = None
    vark: str | None = None
    weakAreas: list[str] = []
    currentLesson: str | None = None


class RagAnswerBody(BaseModel):
    question: str = ""
    allowedModuleIds: list[str] = []
    allowedSubAcquisIds: list[str] = []
    # Class access WITHOUT the progress-frontier restriction — lets the
    # "locked topic" detector tell apart genuinely calendar-locked content
    # from content that's unlocked but not yet reached by this student.
    calendarAllowedModuleIds: list[str] = []
    calendarAllowedSubAcquisIds: list[str] = []
    filterToModuleId: str | None = None
    filterToSubAcquisId: str | None = None
    history: list[ChatTurn] = []
    lang: str = "fr"
    learnerProfile: LearnerProfile | None = None


class AnswerGapBody(BaseModel):
    """A student's free-text explanation of a lesson, to compare against the
    lesson's own indexed content (semantic gap analysis)."""
    moduleId: str = ""
    subAcquisId: str = ""
    text: str = ""
    lang: str = "fr"


@router.post("/rag/reindex")
def rag_reindex(body: RagReindexBody):
    """Build/refresh the student RAG vector store (Chroma) from the curriculum."""
    return rag_index.reindex(body.modules, base_url=body.baseUrl, reset=body.reset)


@router.get("/rag/stats")
def rag_stats():
    return {"storeCount": rag_store.count()}


@router.post("/rag/retrieve")
def rag_retrieve_endpoint(body: RagRetrieveBody):
    """Retrieve top-k chunks (vector or lexical) + the scope/grounding guard flags."""
    chunks = rag_retrieve.retrieve(
        body.question,
        body.allowedModuleIds,
        body.allowedSubAcquisIds,
        filter_module=body.filterToModuleId,
        filter_sub=body.filterToSubAcquisId,
        k=body.k,
    )
    refined = rag_retrieve.refine_chunks(body.question, chunks)
    return {
        "chunks": [
            {
                "moduleId": c.get("moduleId"),
                "moduleName": c.get("moduleName"),
                "subAcquisId": c.get("subAcquisId"),
                "subAcquisName": c.get("subAcquisName"),
                "kind": c.get("kind"),
                "text": c.get("text"),
            }
            for c in refined
        ],
        "guards": {
            "hasGrounding": rag_guards.has_meaningful_grounding(body.question, chunks),
            "outsideLangageC": rag_guards.is_outside_langage_c(body.question),
            "ambiguousProgramming": rag_guards.is_ambiguous_programming(body.question),
        },
    }


@router.post("/rag/answer")
def rag_answer_endpoint(body: RagAnswerBody):
    """Buffered student chatbot answer: retrieve -> guard -> LLM -> grounded check
    -> deterministic fallback. Node does access control + passes allowed ids."""
    return rag_generate.answer(
        body.question,
        body.allowedModuleIds,
        body.allowedSubAcquisIds,
        filter_module=body.filterToModuleId,
        filter_sub=body.filterToSubAcquisId,
        history=[t.model_dump() for t in body.history],
        lang="en" if body.lang == "en" else "fr",
        learner_profile=body.learnerProfile.model_dump() if body.learnerProfile else None,
        calendar_allowed_module_ids=body.calendarAllowedModuleIds,
        calendar_allowed_subacquis_ids=body.calendarAllowedSubAcquisIds,
    )


@router.post("/rag/stream")
def rag_stream_endpoint(body: RagAnswerBody):
    """Streaming student chatbot answer (SSE). Emits meta/delta/sources/done frames
    that Node proxies straight to the browser. Node does access control + passes
    allowed ids; the 'no access' case is handled by Node before it reaches here."""
    gen = rag_generate.stream_answer(
        body.question,
        body.allowedModuleIds,
        body.allowedSubAcquisIds,
        filter_module=body.filterToModuleId,
        filter_sub=body.filterToSubAcquisId,
        history=[t.model_dump() for t in body.history],
        lang="en" if body.lang == "en" else "fr",
        learner_profile=body.learnerProfile.model_dump() if body.learnerProfile else None,
        calendar_allowed_module_ids=body.calendarAllowedModuleIds,
        calendar_allowed_subacquis_ids=body.calendarAllowedSubAcquisIds,
    )
    return StreamingResponse(gen, media_type="text/event-stream; charset=utf-8")


@router.post("/nlp/answer-gap")
def answer_gap_endpoint(body: AnswerGapBody):
    """Semantic gap analysis: which key concepts of the lesson does the
    student's own-words explanation cover / miss. Reference = the lesson's
    indexed chunks; embeddings with a lexical fallback."""
    return rag_answer_gap.analyze(
        body.moduleId, body.subAcquisId, body.text,
        lang="en" if body.lang == "en" else "fr",
    )
