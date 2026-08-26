"""
routers/mastery.py

Per-sous-acquis mastery for one student: a recency-weighted estimate from their
own graded attempts, refined over the curriculum prerequisite graph.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from mastery import skill_graph as mastery_graph
import service_state as state

router = APIRouter()


class Interaction(BaseModel):
    skillId: str
    correct: bool


class MasteryBody(BaseModel):
    """A student's ordered attempt history plus the notions to score.

    history is oldest to newest; each skillId is a sous-acquis id."""
    history: list[Interaction] = []
    targetSkillIds: list[str] = []
    applyGraph: bool = True  # refine over the prerequisite graph


@router.post("/mastery")
def mastery_endpoint(body: MasteryBody):
    """Per-sous-acquis mastery.

    `source` is "history" (the student has attempted this notion), "prior" (no
    attempt yet) or, after graph refinement, "graph" (inferred from evidenced
    neighbours)."""
    history = [(it.skillId, it.correct) for it in body.history]
    scores = state.MASTERY_ESTIMATOR.mastery(history, body.targetSkillIds)
    resp = {"mastery": scores, "graphApplied": False}
    if body.applyGraph:
        graph = mastery_graph.get_graph()
        if graph is not None:
            smoothed = graph.smooth(scores)
            resp["mastery"] = smoothed
            resp["revisionOrder"] = graph.revision_order(smoothed)
            resp["graphApplied"] = True
    return resp
