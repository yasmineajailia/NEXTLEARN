"""
routers/mastery.py

Per-skill mastery from the SAKT knowledge-tracing model, optionally smoothed
over the curriculum prerequisite graph.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from kt import skill_graph as kt_graph
import service_state as state

router = APIRouter()


class KTInteraction(BaseModel):
    skillId: str
    correct: bool


class MasteryBody(BaseModel):
    """A student's ordered attempt history + the skills to score.

    history is oldest->newest; each skillId is a curriculum skill (a sous-acquis
    id for the app, an OULAD assessment id for the shipped demo model)."""
    history: list[KTInteraction] = []
    targetSkillIds: list[str] = []
    applyGraph: bool = True  # refine mastery over the prerequisite graph


@router.post("/mastery")
def mastery_endpoint(body: MasteryBody):
    """Per-skill mastery from the SAKT knowledge-tracing model.

    Returns P(correct-next) for each requested skill, given the student's attempt
    history. `source` per skill is "sakt" (neural estimate), "history" (recency
    fallback for a skill outside the model's vocabulary) or "prior" (no attempts)."""
    history = [(it.skillId, it.correct) for it in body.history]
    scores = state.KT_MODEL.mastery(history, body.targetSkillIds)
    resp = {
        "available": state.KT_MODEL.available,
        "testAuc": round(getattr(state.KT_MODEL, "test_auc", 0.0), 4),
        "mastery": scores,
        "graphApplied": False,
    }
    if body.applyGraph:
        graph = kt_graph.get_graph()
        if graph is not None:
            smoothed = graph.smooth(scores)
            resp["mastery"] = smoothed
            resp["revisionOrder"] = graph.revision_order(smoothed)
            resp["graphApplied"] = True
    return resp
