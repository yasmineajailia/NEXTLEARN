"""
estimator.py — per-sous-acquis mastery from a student's own graded attempts.

Deterministic and parameter-free: each notion's estimate is a recency-weighted
mean of the student's attempts on it, so a recent answer counts for more than an
old one and a student who has since improved is not held to their first try. A
notion with no attempt at all gets a neutral prior rather than zero, since
absence of evidence is not evidence of failure.

The raw estimates are then refined over the prerequisite graph by skill_graph.py
(cold-start transfer, then prerequisite gating).

No model is fitted here. Fitting per-skill parameters needs a volume of learner
interactions in the course's own skill space that a newly deployed platform has
not accumulated.
"""

from __future__ import annotations

from typing import Iterable

RECENCY_DECAY = 0.7   # weight of each older attempt on the same notion
NEUTRAL_PRIOR = 0.5   # no evidence yet


class MasteryEstimator:
    """Stateless: every call derives everything from the history it is given."""

    available = True

    @staticmethod
    def _recency_weighted(history, skill_id) -> float | None:
        """Weighted mean of correctness on one notion, newest attempt first."""
        num = den = 0.0
        weight = 1.0
        for attempted_skill, correct in reversed(history):
            if str(attempted_skill) == str(skill_id):
                num += weight * (1.0 if correct else 0.0)
                den += weight
                weight *= RECENCY_DECAY
        return None if den == 0 else num / den

    def mastery(self, history, target_skill_ids: Iterable) -> dict:
        """Return {skillId: {"mastery": p, "source": "history"|"prior"}}.

        history is [(skillId, correct), ...] oldest to newest.
        """
        out: dict = {}
        for skill_id in (str(s) for s in target_skill_ids):
            weighted = self._recency_weighted(history, skill_id)
            if weighted is None:
                out[skill_id] = {"mastery": NEUTRAL_PRIOR, "source": "prior"}
            else:
                out[skill_id] = {"mastery": round(weighted, 4), "source": "history"}
        return out
