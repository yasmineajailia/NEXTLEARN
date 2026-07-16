"""
generate.py — student chatbot answer generation, ported from rag.ts
(buildStudentChatPrompts, generateStudentChatAnswer, buildStudentRagAnswer,
isRefusalLikeAnswer, isAnswerGroundedInChunks) + the orchestration from
routes/student/chatbot.ts (buildStudentChatContext + the generation block).

`answer()` is the full buffered pipeline: retrieve -> refine -> scope guard ->
LLM generate -> grounded/refusal check -> deterministic fallback. Node still
owns the DB (access control, curriculum) and passes the allowed module/sub-acquis
ids; everything else runs here.
"""

import json
import os

import requests

from . import embed as embedder
from . import retrieve
from .guards import (
    is_outside_langage_c,
    normalize_for_lookup,
    normalize_whitespace,
    tokenize,
)

LLM_TIMEOUT_S = 60


# ── prompts (port of buildStudentChatPrompts) ──────────────────────────────
def build_prompts(question: str, top_chunks: list, lang: str = "fr") -> tuple:
    context = "\n".join(
        f"{i + 1}. [{_label(c)}] ({c.get('kind')}) {c.get('text')}"
        for i, c in enumerate(top_chunks[:6])
    )
    system = "\n".join([
        "Tu es l'assistant pédagogique NextLearn qui aide des étudiants à comprendre le cours de programmation en C. Ton ton est clair, pédagogique et encourageant.",
        "",
        "Règles de contenu (strictes) :",
        "- Utilise UNIQUEMENT les informations du contexte fourni. N'invente rien, n'ajoute aucune connaissance externe ni exemple non présent dans le contexte.",
        "- Si l'information n'est pas dans le contexte, dis-le simplement en une phrase et invite à consulter les ressources du module. Ne refuse la réponse que si la question porte clairement sur un autre langage ou un sujet hors-sujet.",
        "- Tu peux t'appuyer sur les échanges précédents pour comprendre une question de suivi (« explique plus », « et pour ça ? »).",
        "",
        "Style de réponse :",
        "- Va droit au but : commence par une phrase qui répond directement, puis développe si utile.",
        "- Quand tu énumères des étapes ou des éléments, utilise une liste à puces courte plutôt qu'un long paragraphe.",
        "- Si le contexte contient du code C pertinent, illustre avec un petit bloc ```c ... ```.",
        "- Reste concis et naturel. Évite les formulations rigides comme « est défini comme suit » ou « le contexte indique ».",
        "- N'ajoute PAS de section « Sources » : les sources sont affichées automatiquement sous ta réponse.",
        "",
        "Langue : l'étudiant utilise l'interface en ANGLAIS. Réponds intégralement en anglais, même si la question ou le contexte sont en français (le code C reste inchangé)."
        if lang == "en"
        else "Langue : réponds en français.",
    ])
    user = "\n\n".join([
        f"Question de l'étudiant : {question}",
        "Contexte du module (seule source d'information autorisée) :",
        context,
        "Answer the question clearly and naturally in English, relying only on this context."
        if lang == "en"
        else "Réponds à la question de façon claire, pédagogique et naturelle, en t'appuyant uniquement sur ce contexte.",
    ])
    return system, user


def _label(c: dict) -> str:
    if c.get("subAcquisId"):
        return f"{c.get('moduleId')}.{c.get('subAcquisId')} - {c.get('subAcquisName') or 'Sous-acquis'}"
    return f"Module {c.get('moduleId')} - {c.get('moduleName')}"


# ── deterministic fallback (port of buildStudentRagAnswer) ─────────────────
def deterministic_answer(question: str, top_chunks: list) -> str:
    clean = (question or "").strip()
    if not top_chunks:
        return ("Je n'ai pas trouvé de contexte pertinent dans vos modules disponibles. "
                "Essayez avec un identifiant de module (ex: 4) ou de sous-acquis (ex: 4.3).")
    primary = top_chunks[0]
    primary_scope = primary.get("subAcquisName") or primary.get("moduleName") or "le contenu du module"
    evidence = []
    for c in top_chunks[:3]:
        label = f"{c.get('moduleId')}.{c.get('subAcquisId')}" if c.get("subAcquisId") else f"module {c.get('moduleId')}"
        excerpt = normalize_whitespace(str(c.get("text") or ""))[:240]
        tail = "..." if len(excerpt) >= 240 else ""
        evidence.append(f"- {label}: {excerpt}{tail}")
    return "\n".join([
        f"Pour répondre à votre question: {clean}",
        f"Point principal dans le module: {primary_scope}.",
        "Éléments trouvés dans le module:",
        *evidence,
        "Si vous voulez, je peux détailler pas à pas à partir de ces éléments uniquement.",
    ])


# ── grounding + refusal checks ─────────────────────────────────────────────
def is_refusal_like(answer: str) -> bool:
    n = normalize_for_lookup(answer)
    return any(p in n for p in (
        "je ne peux pas",
        "je ne peux pas fournir",
        "je ne peux pas vous aider",
        "je ne peux pas repondre",
        "pas fournir d'informations",
        "hors contexte",
    ))


def is_answer_grounded(answer: str, chunks: list) -> bool:
    na = normalize_for_lookup(answer)
    if not na or not chunks:
        return False
    seen, matches = set(), 0
    for c in chunks:
        candidates = [
            normalize_for_lookup(str(c.get("subAcquisName") or "").strip()),
            normalize_for_lookup(str(c.get("moduleName") or "").strip()),
            normalize_for_lookup(
                f"{c.get('moduleId')}.{c.get('subAcquisId')}" if c.get("subAcquisId")
                else f"module {c.get('moduleId')}"
            ),
        ]
        for cand in candidates:
            if len(cand) < 3 or cand in seen:
                continue
            if cand in na:
                seen.add(cand)
                matches += 1
        if matches >= 1:
            return True

    vocab = set()
    for c in chunks:
        vocab.update(tokenize(str(c.get("text") or "")))
    if not vocab:
        return False
    answer_tokens = [t for t in tokenize(answer) if len(t) >= 4]
    if len(answer_tokens) < 3:
        return False
    overlap = sum(1 for t in answer_tokens if t in vocab)
    return overlap >= 4 or overlap / len(answer_tokens) >= 0.35


# ── LLM generation (port of generateStudentChatAnswer) ─────────────────────
def _extract_gemini_text(payload: dict) -> str:
    parts = ((payload.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    return "".join(str(p.get("text", "")) for p in parts if isinstance(p, dict)).strip()


def _gemini(system: str, user: str, history: list) -> str:
    key = os.environ["GEMINI_API_KEY"]
    base = os.environ.get("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
    models = [os.environ.get("GEMINI_CHAT_MODEL", "gemini-1.5-flash"), "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b"]
    seen = set()
    contents = [
        {"role": "model" if t.get("role") == "assistant" else "user", "parts": [{"text": t.get("content", "")}]}
        for t in (history or [])
    ] + [{"role": "user", "parts": [{"text": user}]}]
    for model in [m for m in models if m and not (m in seen or seen.add(m))]:
        r = requests.post(
            f"{base}/models/{model}:generateContent?key={key}",
            json={"systemInstruction": {"parts": [{"text": system}]},
                  "contents": contents, "generationConfig": {"temperature": 0.2}},
            timeout=LLM_TIMEOUT_S,
        )
        if r.status_code == 404:
            continue
        if not r.ok:
            break
        text = _extract_gemini_text(r.json())
        if text:
            return text
    return ""


def _openai(system: str, user: str, history: list) -> str:
    key = os.environ["OPENAI_API_KEY"]
    base = os.environ.get("OPENAI_CHAT_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("OPENAI_CHAT_MODEL", "gpt-4o-mini")
    messages = [{"role": "system", "content": system}] + [
        {"role": t.get("role"), "content": t.get("content", "")} for t in (history or [])
    ] + [{"role": "user", "content": user}]
    r = requests.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"model": model, "temperature": 0.2, "messages": messages},
        timeout=LLM_TIMEOUT_S,
    )
    if not r.ok:
        return ""
    content = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content", "")
    return str(content).strip() if content else ""


def generate(question: str, top_chunks: list, history: list, lang: str = "fr") -> str | None:
    if not (os.environ.get("OPENAI_API_KEY") or os.environ.get("GEMINI_API_KEY")):
        return None
    if not top_chunks:
        return None
    system, user = build_prompts(question, top_chunks, lang)
    if os.environ.get("GEMINI_API_KEY"):
        text = _gemini(system, user, history)
        if text:
            return text
    if os.environ.get("OPENAI_API_KEY"):
        return _openai(system, user, history) or None
    return None


SCOPE_GUARD_ANSWER = (
    "Je peux vous aider uniquement sur le module en cours et en langage C. "
    "Reformulez votre question sans mentionner un autre langage."
)


# ── streaming generation (port of streamStudentChatAnswer) ─────────────────
# Mirrors the JS stream route exactly: OpenAI only (Gemini is not streamed),
# raw token deltas, NO grounding/refusal re-check, mode suffix "+stream",
# deterministic fallback when nothing streamed.
def stream_generate(question: str, top_chunks: list, history: list, lang: str = "fr"):
    """Yield answer text deltas from the OpenAI streaming endpoint. Yields nothing
    if there is no OpenAI key or no context (caller then uses the deterministic
    fallback). Raises on an HTTP error so the caller can fall back."""
    key = os.environ.get("OPENAI_API_KEY")
    if not key or not top_chunks:
        return
    system, user = build_prompts(question, top_chunks, lang)
    base = os.environ.get("OPENAI_CHAT_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("OPENAI_CHAT_MODEL", "gpt-4o-mini")
    messages = [{"role": "system", "content": system}] + [
        {"role": t.get("role"), "content": t.get("content", "")} for t in (history or [])
    ] + [{"role": "user", "content": user}]
    with requests.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"model": model, "temperature": 0.2, "stream": True, "messages": messages},
        timeout=LLM_TIMEOUT_S,
        stream=True,
    ) as r:
        if not r.ok:
            raise RuntimeError(f"Chat stream failed ({r.status_code})")
        # requests defaults to ISO-8859-1 for text/event-stream (no charset in the
        # header), which mojibakes accented UTF-8 deltas. The stream is UTF-8.
        r.encoding = "utf-8"
        for raw in r.iter_lines(decode_unicode=True):
            if not raw:
                continue
            line = raw.strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                choice = (json.loads(data).get("choices") or [{}])[0]
                delta = (choice.get("delta") or {}).get("content")
                if isinstance(delta, str) and delta:
                    yield delta
            except Exception:  # noqa: BLE001 — keep-alive / partial frame
                continue


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def stream_answer(question, allowed_module_ids, allowed_subacquis_ids,
                  filter_module=None, filter_sub=None, history=None, lang="fr"):
    """Yield the full SSE event stream (event:/data: frames) for the streaming
    chatbot route: meta -> delta* -> sources -> done. Node proxies these frames
    straight to the browser, so the events match the JS route 1:1. The 'empty'
    (no accessible modules) case is handled by Node before this is called."""
    ranked = retrieve.retrieve(question, allowed_module_ids, allowed_subacquis_ids, filter_module, filter_sub)
    refined = retrieve.refine_chunks(question, ranked)

    if (filter_module or filter_sub) and is_outside_langage_c(question):
        yield _sse("meta", {"mode": "scope-guard"})
        yield _sse("delta", {"text": SCOPE_GUARD_ANSWER})
        yield _sse("sources", {"sources": []})
        yield _sse("done", {})
        return

    sources = [{
        "moduleId": c.get("moduleId"),
        "moduleName": c.get("moduleName"),
        "subAcquisId": c.get("subAcquisId"),
        "subAcquisName": c.get("subAcquisName"),
        "kind": c.get("kind"),
        "excerpt": normalize_whitespace(str(c.get("text") or ""))[:300],
    } for c in refined]

    mode = "vector" if embedder.has_provider() else "rag"
    yield _sse("meta", {"mode": f"{mode}+stream"})

    streamed = ""
    try:
        for delta in stream_generate(question, refined, history or [], lang):
            streamed += delta
            yield _sse("delta", {"text": delta})
    except Exception:  # noqa: BLE001 — stream failure -> deterministic fallback
        pass

    if not streamed:
        yield _sse("delta", {"text": deterministic_answer(question, refined)})

    yield _sse("sources", {"sources": sources})
    yield _sse("done", {})


# ── orchestrator (port of buildStudentChatContext + generation block) ──────
def answer(question, allowed_module_ids, allowed_subacquis_ids,
           filter_module=None, filter_sub=None, history=None, lang="fr") -> dict:
    ranked = retrieve.retrieve(question, allowed_module_ids, allowed_subacquis_ids, filter_module, filter_sub)
    refined = retrieve.refine_chunks(question, ranked)

    if (filter_module or filter_sub) and is_outside_langage_c(question):
        return {"answer": SCOPE_GUARD_ANSWER, "mode": "scope-guard", "retrieved": 0, "sources": []}

    sources = [{
        "moduleId": c.get("moduleId"),
        "moduleName": c.get("moduleName"),
        "subAcquisId": c.get("subAcquisId"),
        "subAcquisName": c.get("subAcquisName"),
        "kind": c.get("kind"),
        "excerpt": normalize_whitespace(str(c.get("text") or ""))[:300],
    } for c in refined]

    ans = deterministic_answer(question, refined)
    mode = "vector" if embedder.has_provider() else "rag"
    try:
        gen = generate(question, refined, history or [], lang)
        if gen and not is_refusal_like(gen) and is_answer_grounded(gen, refined):
            ans = gen
            mode = f"{mode}+llm"
    except Exception:  # noqa: BLE001 — generation failure -> deterministic fallback
        pass

    return {"answer": ans, "mode": mode, "retrieved": len(sources), "sources": sources}
