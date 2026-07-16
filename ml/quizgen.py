"""
quizgen.py

Teacher quiz generation (the AI feature) moved out of Node into Python. Given a
sous-acquis and optional course-content snippets, it builds the French prompts,
calls the configured LLM (Gemini first, then OpenAI), parses + validates the
returned questions, and falls back to template questions built from the course
content when no LLM is available or the call fails.

Secrets: read from the environment (GEMINI_API_KEY / OPENAI_API_KEY etc.). When
the Node supervisor spawns this service it inherits them from process.env; run
standalone, `shap_service.py` loads the project `.env` via python-dotenv.
Mirrors the old src/routes/web.ts generateTeacherQuizQuestions faithfully.
"""

import json
import os
import random
import re

import requests

LLM_TIMEOUT_S = 45


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default) or default


def _build_prompts(p: dict) -> tuple:
    module_name = p.get("moduleName") or p.get("moduleId") or ""
    module_id = p.get("moduleId") or ""
    acquis_name = p.get("acquisName") or ""
    sub_name = p.get("subAcquisName") or ""
    sub_id = p.get("subAcquisId") or ""
    difficulty = p.get("difficulty") or "intermediate"
    count = int(p.get("count") or 5)
    course_content = p.get("courseContent") or []

    breadcrumb = " > ".join([x for x in [module_name, acquis_name, sub_name] if x])
    topic = p.get("topic") or breadcrumb or sub_name or module_name or f"{module_id} / {sub_id}"

    has_content = isinstance(course_content, list) and len(course_content) > 0
    content_section = (
        f"\n\n--- Contenu du cours (extrait des supports PDF/PPT) ---\n"
        + "\n\n---\n".join(course_content)
        + "\n--- Fin du contenu ---"
        if has_content
        else ""
    )
    acquis_clause = f" (acquis : {acquis_name})" if acquis_name else ""

    if has_content:
        system = (
            f'Tu es un expert pédagogique en informatique. Génère exactement {count} questions de quiz '
            f'en français sur "{sub_name}" dans le module "{module_name}"{acquis_clause}, niveau "{difficulty}". '
            f"BASE TES QUESTIONS PRINCIPALEMENT SUR LE CONTENU DU COURS FOURNI.\n"
            f"Chaque question doit avoir exactement 4 options avec une seule bonne réponse. "
            f"Retourne UNIQUEMENT un JSON valide sans texte autour.\n"
            f'Format attendu: {{"questions":[{{"prompt":"...","options":["...","...","...","..."],"correctOptionIndex":0}},...]}}'
        )
    else:
        system = (
            f'Tu es un expert pédagogique en informatique. Génère exactement {count} questions de quiz '
            f'en français sur "{sub_name}" dans le module "{module_name}"{acquis_clause}, niveau "{difficulty}".\n'
            f"Chaque question doit avoir exactement 4 options avec une seule bonne réponse. "
            f"Retourne UNIQUEMENT un JSON valide sans texte autour.\n"
            f'Format attendu: {{"questions":[{{"prompt":"...","options":["...","...","...","..."],"correctOptionIndex":0}},...]}}'
        )

    user_lines = [
        f"Module : {module_name} ({module_id})",
        f"Acquis : {acquis_name}" if acquis_name else None,
        f"Sous-acquis : {sub_name}",
        f"Thème complet : {topic}",
        f"Difficulté : {difficulty}",
        f"Nombre de questions : {count}",
        content_section,
        "\nGénère les questions au format JSON. Chaque question doit :",
        "- S'appuyer sur le contenu du cours fourni ci-dessus"
        if has_content
        else "- Porter spécifiquement sur le sous-acquis indiqué",
        "- Être adaptée au niveau de difficulté choisi",
        "- Avoir exactement 4 options claires et distinctes",
        "- Avoir une seule bonne réponse",
    ]
    user = "\n".join([ln for ln in user_lines if ln is not None])
    return system, user, topic


def _valid(q: dict) -> bool:
    return (
        bool(q.get("prompt"))
        and isinstance(q.get("options"), list)
        and len(q["options"]) == 4
        and isinstance(q.get("correctOptionIndex"), int)
        and 0 <= q["correctOptionIndex"] < 4
    )


def _coerce(parsed: dict) -> list:
    if not isinstance(parsed, dict) or not isinstance(parsed.get("questions"), list):
        return []
    out = []
    for q in parsed["questions"]:
        if not isinstance(q, dict):
            continue
        opts = [str(o).strip() for o in q.get("options", []) if str(o).strip()]
        try:
            idx = int(q.get("correctOptionIndex"))
        except (TypeError, ValueError):
            continue
        cand = {"prompt": str(q.get("prompt", "")).strip(), "options": opts, "correctOptionIndex": idx}
        if _valid(cand):
            out.append(cand)
    return out


def _parse_questions(raw: str) -> list:
    trimmed = (raw or "").strip()
    if not trimmed:
        return []
    try:
        return _coerce(json.loads(trimmed))
    except json.JSONDecodeError:
        start, end = trimmed.find("{"), trimmed.rfind("}")
        if 0 <= start < end:
            try:
                return _coerce(json.loads(trimmed[start : end + 1]))
            except json.JSONDecodeError:
                return []
        return []


def _gemini(system: str, user: str) -> list:
    key = _env("GEMINI_API_KEY")
    if not key:
        return []
    base = _env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
    models = [_env("GEMINI_CHAT_MODEL", "gemini-1.5-flash"), "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b"]
    seen = set()
    for model in [m for m in models if m and not (m in seen or seen.add(m))]:
        try:
            r = requests.post(
                f"{base}/models/{model}:generateContent?key={key}",
                json={
                    "systemInstruction": {"parts": [{"text": system}]},
                    "contents": [{"role": "user", "parts": [{"text": user}]}],
                    "generationConfig": {"temperature": 0.7, "topP": 0.9},
                },
                timeout=LLM_TIMEOUT_S,
            )
            if r.status_code == 404:
                continue  # model not available for this key; try the next
            if not r.ok:
                break
            parts = (r.json().get("candidates") or [{}])[0].get("content", {}).get("parts") or []
            text = "".join(str(part.get("text", "")) for part in parts if isinstance(part, dict))
            parsed = _parse_questions(text)
            if parsed:
                return parsed
        except requests.RequestException:
            break
    return []


def _openai(system: str, user: str) -> list:
    key = _env("OPENAI_API_KEY")
    if not key:
        return []
    base = _env("OPENAI_CHAT_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = _env("OPENAI_CHAT_MODEL", "gpt-4o-mini")
    try:
        r = requests.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "temperature": 0.7,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            },
            timeout=LLM_TIMEOUT_S,
        )
        if not r.ok:
            return []
        content = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content", "")
        return _parse_questions(content if isinstance(content, str) else "")
    except requests.RequestException:
        return []


def _fallback(course_content: list, count: int, topic: str) -> list:
    """Template questions from the course content (or generic) when no LLM answers."""
    questions = []
    if isinstance(course_content, list) and course_content:
        sentences = [
            s.strip()
            for c in course_content
            for s in re.split(r"(?<=[.!?])\s+", str(c or ""))
            if len(s.strip()) > 20
        ]
        for i in range(count):
            base = sentences[i % max(1, len(sentences))] if sentences else f"Énoncé correct sur {topic}"
            pool = [s for s in sentences if s != base]
            random.shuffle(pool)
            distractors = [(s[:116].strip() + "...") if len(s) > 120 else s for s in pool[:3]]
            while len(distractors) < 3:
                distractors.append(f"Autre proposition liée à {topic}")
            options = [base] + distractors
            random.shuffle(options)
            options = options[:4]
            correct = options.index(base) if base in options else 0
            prompt = (
                "Dans le contexte du module, laquelle des propositions suivantes est correcte ?\n"
                + re.sub(r"\s+", " ", base)[:320]
            )
            questions.append({"prompt": prompt, "options": options, "correctOptionIndex": correct, "source": "fallback"})
        return questions[:count]

    for i in range(count):
        questions.append({
            "prompt": f'Question {i + 1} sur "{topic}" - Quel énoncé est correct ?',
            "options": [
                "Option A - Répondre avec le contenu du cours",
                "Option B - Répondre avec le contenu du cours",
                "Option C - Répondre avec le contenu du cours (correcte)",
                "Option D - Répondre avec le contenu du cours",
            ],
            "correctOptionIndex": 2,
            "source": "fallback",
        })
    return questions[:count]


def generate_quiz(p: dict) -> list:
    system, user, topic = _build_prompts(p)
    count = int(p.get("count") or 5)
    try:
        ai = _gemini(system, user) or _openai(system, user)
        if ai:
            return [{**q, "source": "ai"} for q in ai][:count]
    except Exception:  # noqa: BLE001 — never let generation crash the request
        pass
    return _fallback(p.get("courseContent") or [], count, topic)
