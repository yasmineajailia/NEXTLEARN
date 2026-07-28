"""
skill_graph.py — prerequisite-graph smoothing on top of per-skill mastery.

Loads the C-course sous-acquis dependency graph (data/graph.json) and refines the
raw mastery from the SAKT model / recency fallback in two deterministic passes:

  1. Cold-start transfer — a skill with NO direct evidence borrows an estimate
     from its graph neighbours (depends_on / unlocks / related_to) that do have
     evidence. This is the main win for a small course: mastery for a barely
     practised sous-acquis is informed by related ones.

  2. Prerequisite gating — processed in topological order, each skill's mastery is
     pulled toward its prerequisites' mastery when those are weaker ("you can't
     have mastered X while its foundation is shaky"). It never inflates a score.

No training and no learned parameters — a transparent layer, safe to ship, that
also yields a prerequisite-aware revision order.
"""
from __future__ import annotations

import json
import os
from collections import deque

# Blend weight for prerequisite gating (how hard a weak prerequisite pulls down).
PREREQ_ALPHA = 0.5
# source values that mean "the student has direct evidence on this skill".
EVIDENCE_SOURCES = {"sakt", "history"}
WEAK_THRESHOLD = 0.6  # below this a skill is flagged as needing revision


def _locate_graph() -> str:
    for path in (
        "data/graph.json",
        os.path.join(os.path.dirname(__file__), "..", "..", "data", "graph.json"),
    ):
        if os.path.exists(path):
            return os.path.normpath(path)
    raise FileNotFoundError("data/graph.json not found")


def _norm(ids) -> list:
    """Trim ids (the graph has a stray '4.1 ') and drop blanks/dupes in order."""
    seen, out = set(), []
    for i in ids or []:
        s = str(i).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


class SkillGraph:
    def __init__(self, path: str | None = None):
        data = json.load(open(path or _locate_graph(), encoding="utf-8"))
        subs = data.get("sub_skills", {})
        self.nodes = set(subs)
        self.depends_on: dict[str, list] = {}
        self.neighbors: dict[str, list] = {}
        for sid, node in subs.items():
            deps = [d for d in _norm(node.get("depends_on")) if d in self.nodes]
            nbrs = _norm(node.get("depends_on")) + _norm(node.get("unlocks")) + _norm(node.get("related_to"))
            self.depends_on[sid] = deps
            self.neighbors[sid] = [n for n in dict.fromkeys(nbrs) if n in self.nodes and n != sid]
        self._topo = self._topological_order()

    def _topological_order(self) -> list:
        indeg = {n: 0 for n in self.nodes}
        for n in self.nodes:
            for _d in self.depends_on[n]:
                indeg[n] += 1
        queue = deque(sorted(n for n in self.nodes if indeg[n] == 0))
        order, indeg = [], dict(indeg)
        # dependents = reverse of depends_on
        dependents: dict[str, list] = {n: [] for n in self.nodes}
        for n in self.nodes:
            for d in self.depends_on[n]:
                dependents[d].append(n)
        while queue:
            n = queue.popleft()
            order.append(n)
            for m in dependents[n]:
                indeg[m] -= 1
                if indeg[m] == 0:
                    queue.append(m)
        # append any leftover (defensive; graph is a DAG so normally none)
        order += [n for n in self.nodes if n not in order]
        return order

    def smooth(self, mastery: dict) -> dict:
        """mastery: ``{skillId: {"mastery": float, "source": str}}``.
        Returns the same skills with graph-refined mastery + the raw value kept.
        Skills absent from the graph pass through unchanged."""
        cur = {s: float(v.get("mastery", 0.5)) for s, v in mastery.items()}
        src = {s: str(v.get("source", "prior")) for s, v in mastery.items()}
        raw = dict(cur)

        # Pass 1 — cold-start transfer for skills with no direct evidence.
        for sid in mastery:
            if sid not in self.nodes or src[sid] in EVIDENCE_SOURCES:
                continue
            evid = [n for n in self.neighbors[sid] if n in cur and src.get(n) in EVIDENCE_SOURCES]
            if evid:
                cur[sid] = sum(cur[n] for n in evid) / len(evid)
                src[sid] = "graph"

        # Pass 2 — prerequisite gating in topological order.
        for sid in self._topo:
            if sid not in cur:
                continue
            prereqs = [p for p in self.depends_on[sid] if p in cur]
            if not prereqs:
                continue
            prq = sum(cur[p] for p in prereqs) / len(prereqs)
            cur[sid] = (1 - PREREQ_ALPHA) * cur[sid] + PREREQ_ALPHA * min(cur[sid], prq)

        return {
            s: {"mastery": round(cur[s], 4), "rawMastery": round(raw[s], 4), "source": src[s]}
            for s in mastery
        }

    def revision_order(self, smoothed: dict, limit: int = 10) -> list:
        """Weakest-first list of graph skills, each annotated with the weak
        prerequisites that block it (revise those first)."""
        graph_skills = [s for s in smoothed if s in self.nodes]
        graph_skills.sort(key=lambda s: smoothed[s]["mastery"])
        out = []
        for s in graph_skills[:limit]:
            blocked_by = [
                p for p in self.depends_on[s]
                if p in smoothed and smoothed[p]["mastery"] < WEAK_THRESHOLD
            ]
            out.append({
                "skillId": s,
                "mastery": smoothed[s]["mastery"],
                "blockedBy": blocked_by,
            })
        return out


_GRAPH: SkillGraph | None = None


def get_graph() -> SkillGraph | None:
    """Lazy singleton; returns None if the graph file is missing."""
    global _GRAPH
    if _GRAPH is None:
        try:
            _GRAPH = SkillGraph()
        except FileNotFoundError:
            return None
    return _GRAPH
