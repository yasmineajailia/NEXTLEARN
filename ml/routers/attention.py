"""
routers/attention.py

Teacher-dashboard analytics over DERIVED attention metrics only — webcam
frames/landmarks never leave the browser; only per-session focus scores and
distraction reason codes reach this endpoint.
"""

from collections import Counter

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class AttentionStudent(BaseModel):
    """One student's derived attention history — NO frames/landmarks, by design.
    avgScores: chronological per-session focus scores. distractions: flat list of
    distraction reason codes across sessions."""
    avgScores: list[float] = []
    distractions: list[str] = []


class AttentionBody(BaseModel):
    students: list[AttentionStudent]


def _focus_trend(scores: list) -> str:
    """last-3 vs previous-3 mean focus: >+5 improving, <-5 declining, else stable."""
    if len(scores) < 6:
        return "stable"
    last3 = scores[-3:]
    prev3 = scores[-6:-3]
    delta = (sum(last3) / 3.0) - (sum(prev3) / 3.0)
    if delta > 5:
        return "improving"
    if delta < -5:
        return "declining"
    return "stable"


def _top_distraction(reasons: list):
    counts = Counter(r for r in reasons if r)
    return counts.most_common(1)[0][0] if counts else None


@router.post("/attention-analytics")
def attention_analytics(body: AttentionBody):
    """Teacher-dashboard analytics over DERIVED attention metrics only (no biometrics
    ever reach the server — frame scoring stays in the browser). Batched per class."""
    results = [
        {"trend": _focus_trend(st.avgScores), "topDistraction": _top_distraction(st.distractions)}
        for st in body.students
    ]
    return {"results": results}
