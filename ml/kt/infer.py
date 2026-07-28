"""
infer.py — serving-time per-skill mastery from the trained SAKT model.

``KTModel`` loads ``ml/models/kt-sakt.pt`` once and answers: given a student's
ordered history of ``(skillId, correct)`` interactions, what is P(correct) if
each candidate skill were asked next? That probability is the *mastery* estimate.

Skill-vocabulary bridge: the deployed weights learn one skill space (the space
the model was trained on — OULAD assessments for the shipped checkpoint, or the
C-course sous-acquis once a model is trained on app data). For any requested
skill NOT in that space we fall back to a recency-weighted mean of the student's
own answers on that skill, so the endpoint is always useful and upgrades to the
neural estimate automatically when a matching model is trained.
"""
from __future__ import annotations

import os
from typing import Iterable

import torch

try:  # works both as a package (kt.infer, from the service) and as a script
    from .sakt import SAKT
except ImportError:  # pragma: no cover
    from sakt import SAKT

MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "kt-sakt.pt")
RECENCY_DECAY = 0.7  # weight of older attempts in the cold-start fallback


class KTModel:
    def __init__(self, path: str = MODEL_PATH):
        self.available = False
        self.skill2idx: dict = {}
        self.num_skills = 0
        self.maxlen = 50
        self.model: SAKT | None = None
        path = os.path.normpath(path)
        if not os.path.exists(path):
            return
        ckpt = torch.load(path, map_location="cpu", weights_only=False)
        cfg = ckpt["config"]
        self.num_skills = cfg["num_skills"]
        self.maxlen = cfg["maxlen"]
        # skill2idx keys may be JSON-stringified; normalize to str for lookup.
        self.skill2idx = {str(k): int(v) for k, v in ckpt["skill2idx"].items()}
        self.test_auc = float(ckpt.get("test_auc", 0.0))
        self.model = SAKT(self.num_skills, self.maxlen, cfg["d_model"],
                          cfg["n_heads"], cfg["dropout"])
        self.model.load_state_dict(ckpt["state_dict"])
        self.model.eval()
        self.available = True

    # ── cold-start fallback ────────────────────────────────────────────────
    @staticmethod
    def _recency_weighted(history, skill_id) -> float | None:
        num = den = 0.0
        w = 1.0
        # walk newest -> oldest so recent answers weigh most
        for sk, correct in reversed(history):
            if str(sk) == str(skill_id):
                num += w * (1.0 if correct else 0.0)
                den += w
                w *= RECENCY_DECAY
        return None if den == 0 else num / den

    def _encode_history_indices(self, history):
        """Map raw skill ids -> model indices, dropping interactions on skills the
        model never saw (they carry no signal in this skill space)."""
        idxs = []
        for sk, correct in history:
            j = self.skill2idx.get(str(sk))
            if j is not None:
                idxs.append((j, int(bool(correct))))
        return idxs[-self.maxlen:]

    @torch.no_grad()
    def mastery(self, history, target_skill_ids: Iterable) -> dict:
        """Return ``{skillId: {"mastery": p, "source": "sakt"|"history"|"prior"}}``.

        history: ``[(skillId, correct), ...]`` oldest→newest.
        target_skill_ids: skills to score (defaults handled by caller).
        """
        target_skill_ids = [str(s) for s in target_skill_ids]
        out: dict = {}

        known = [s for s in target_skill_ids if s in self.skill2idx]
        unknown = [s for s in target_skill_ids if s not in self.skill2idx]

        if self.available and known:
            enc = self._encode_history_indices(history)
            if enc:
                length = len(enc)
                inter = [e[0] + e[1] * self.num_skills for e in enc]
                pad = self.maxlen - length
                inter_t = torch.tensor([inter + [0] * pad], dtype=torch.long)
                # One row per target skill; the queried skill sits at the last real
                # position so it attends the whole history.
                rows_q, order = [], []
                for s in known:
                    q = [0] * self.maxlen
                    q[length - 1] = self.skill2idx[s]
                    rows_q.append(q)
                    order.append(s)
                query_t = torch.tensor(rows_q, dtype=torch.long)
                inter_b = inter_t.expand(len(order), -1)
                logits = self.model(inter_b, query_t)  # [S, L]
                probs = torch.sigmoid(logits[:, length - 1]).tolist()
                for s, p in zip(order, probs):
                    out[s] = {"mastery": round(float(p), 4), "source": "sakt"}
            else:
                unknown = target_skill_ids  # no usable history in this skill space

        for s in unknown:
            rw = self._recency_weighted(history, s)
            if rw is None:
                out[s] = {"mastery": 0.5, "source": "prior"}       # no attempts yet
            else:
                out[s] = {"mastery": round(rw, 4), "source": "history"}
        return out
