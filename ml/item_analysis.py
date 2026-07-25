"""
item_analysis.py — classical test theory item analysis for quiz quality.

Given the per-question responses captured in User.progress.skillAttempts, this
computes, for each question of a quiz:

  - difficulty      : proportion of students who answered it correctly
                      (a "p-value"; higher = easier)
  - discrimination  : rest-corrected point-biserial correlation between getting
                      THIS item right and the score on the OTHER items. A good
                      item is answered correctly more often by strong students;
                      a NEGATIVE value flags a likely broken / miskeyed question.
  - flag            : ok | too_easy | too_hard | weak | misleading | insufficient_data

Plus a quiz-level summary with KR-20 reliability (Cronbach's alpha for
dichotomous items). This is the psychometric foundation of IRT and the standard
way teachers quality-check a quiz — here applied to the AI-generated questions.

Pure functions, numpy-only, so they are unit-testable without the web service.
"""

from __future__ import annotations

import numpy as np

# Below this many respondents, item statistics are too noisy to trust.
MIN_RESPONSES = 5


def _flag(n: int, p: float, disc: float | None) -> str:
    if n < MIN_RESPONSES:
        return "insufficient_data"
    if p >= 0.95:
        return "too_easy"
    if p <= 0.20:
        return "too_hard"
    if disc is not None and disc < 0:
        return "misleading"
    if disc is not None and disc < 0.15:
        return "weak"
    return "ok"


def _kr20(parsed: list[dict], all_q: list[int]) -> float | None:
    """KR-20 reliability over students who answered every item (clean matrix)."""
    complete = [m for m in parsed if all(qi in m for qi in all_q)]
    k = len(all_q)
    if k < 2 or len(complete) < 3:
        return None
    mat = np.array([[m[qi] for qi in all_q] for m in complete], dtype=float)
    total = mat.sum(axis=1)
    var_total = float(total.var(ddof=1))
    if var_total <= 1e-9:
        return None
    p = mat.mean(axis=0)
    q = 1.0 - p
    return float((k / (k - 1)) * (1.0 - (p * q).sum() / var_total))


def analyze(attempts: list) -> dict:
    """attempts: list of { "responses": [ {questionIndex, correct, gradable} ] }.

    Only gradable responses are considered. Returns { items, summary }.
    """
    parsed: list[dict] = []
    for a in attempts or []:
        responses = (a or {}).get("responses") or []
        row: dict[int, int] = {}
        for r in responses:
            if not isinstance(r, dict) or r.get("gradable") is False:
                continue
            qi = r.get("questionIndex")
            try:
                qi = int(qi)
            except (TypeError, ValueError):
                continue
            row[qi] = 1 if r.get("correct") else 0
        if row:
            parsed.append(row)

    n_attempts = len(parsed)
    all_q = sorted({qi for row in parsed for qi in row})

    if not all_q:
        return {
            "items": [],
            "summary": {
                "nAttempts": n_attempts,
                "nQuestions": 0,
                "meanDifficulty": None,
                "reliabilityAlpha": None,
                "flaggedCount": 0,
            },
        }

    totals = [sum(row.values()) for row in parsed]

    items = []
    p_values = []
    for qi in all_q:
        xs, rests = [], []
        for i, row in enumerate(parsed):
            if qi in row:
                x = row[qi]
                xs.append(x)
                rests.append(totals[i] - x)
        xs_arr = np.array(xs, dtype=float)
        rests_arr = np.array(rests, dtype=float)
        n = int(len(xs_arr))
        p = float(xs_arr.mean()) if n else 0.0

        disc: float | None = None
        if n >= 2 and xs_arr.std() > 1e-9 and rests_arr.std() > 1e-9:
            disc = float(np.corrcoef(xs_arr, rests_arr)[0, 1])

        p_values.append(p)
        items.append({
            "questionIndex": qi,
            "n": n,
            "difficulty": round(p, 3),
            "discrimination": round(disc, 3) if disc is not None else None,
            "flag": _flag(n, p, disc),
        })

    alpha = _kr20(parsed, all_q)
    flagged = sum(1 for it in items if it["flag"] in ("too_easy", "too_hard", "weak", "misleading"))

    return {
        "items": items,
        "summary": {
            "nAttempts": n_attempts,
            "nQuestions": len(all_q),
            "meanDifficulty": round(float(np.mean(p_values)), 3) if p_values else None,
            "reliabilityAlpha": round(alpha, 3) if alpha is not None else None,
            "flaggedCount": flagged,
        },
    }
