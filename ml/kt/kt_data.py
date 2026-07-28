"""
kt_data.py — Knowledge-tracing sequence data for the SAKT mastery model.

Builds per-student ordered interaction sequences from the OULAD assessments:
each interaction is ``(skill, correct)`` where ``skill = id_assessment`` and
``correct = (score >= 40)`` (40 is the OULAD pass threshold). Interactions are
ordered by submission date.

That ``list[(skill_idx, correct)]`` shape is exactly what the live app produces
from a student's sous-acquis quiz attempts, so training (OULAD) and serving
(the C course) share one representation — only the skill vocabulary differs.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

PASS_THRESHOLD = 40.0  # OULAD: a module assessment score >= 40 is a pass
MIN_SEQ = 2            # need >= 2 interactions to form one (history -> predict) pair


def locate_raw_dir() -> str:
    """Find the OULAD CSV folder whether run from repo root or ml/kt/."""
    candidates = [
        "data/OULAD_DATASET",
        "../../data/OULAD_DATASET",
        os.path.join(os.path.dirname(__file__), "..", "..", "data", "OULAD_DATASET"),
    ]
    for path in candidates:
        if os.path.exists(os.path.join(path, "studentAssessment.csv")):
            return path
    raise FileNotFoundError("Could not locate data/OULAD_DATASET (studentAssessment.csv)")


def load_oulad_sequences(raw_dir: str | None = None):
    """Return ``(sequences, skill2idx)``.

    sequences: list of ``(student_id, [(skill_idx, correct), ...])`` in time order.
    skill2idx: ``{id_assessment: idx}`` with idx in ``1..S`` (0 is reserved for padding).
    """
    raw_dir = raw_dir or locate_raw_dir()
    assessments = pd.read_csv(os.path.join(raw_dir, "assessments.csv"))
    sa = pd.read_csv(os.path.join(raw_dir, "studentAssessment.csv"))

    sa = sa.dropna(subset=["score"]).copy()
    sa["score"] = sa["score"].astype(float)
    sa["correct"] = (sa["score"] >= PASS_THRESHOLD).astype(int)

    # Stable skill vocabulary (sorted) so indices are reproducible across runs.
    skills = sorted(int(a) for a in assessments["id_assessment"].unique())
    skill2idx = {a: i + 1 for i, a in enumerate(skills)}  # 0 = padding
    sa = sa[sa["id_assessment"].isin(skill2idx)]
    sa["skill_idx"] = sa["id_assessment"].astype(int).map(skill2idx)

    sa = sa.sort_values(["id_student", "date_submitted", "id_assessment"])
    sequences = []
    for sid, group in sa.groupby("id_student", sort=False):
        seq = list(zip(group["skill_idx"].tolist(), group["correct"].tolist()))
        if len(seq) >= MIN_SEQ:
            sequences.append((int(sid), seq))
    return sequences, skill2idx


def to_tensors(sequences, num_skills: int, maxlen: int = 50):
    """Vectorize sequences into SAKT input arrays.

    For a student sequence ``[(s_0,r_0) .. (s_{n-1},r_{n-1})]`` we predict each
    response from the history that precedes it::

        inter[i]  = encode(s_i, r_i) = s_i + r_i * num_skills   # past interaction i
        query[i]  = s_{i+1}                                     # skill being asked
        target[i] = r_{i+1}                                     # 1 if answered right

    so position ``i`` predicts the next response using interactions ``0..i``.
    Right-padded to ``maxlen`` (keeps the most recent ``maxlen`` steps if longer).
    Returns ``(inter, query, target, mask)`` each shaped ``[N, maxlen]``.
    """
    inter, query, target, mask = [], [], [], []
    for _sid, seq in sequences:
        s = [x[0] for x in seq]
        r = [x[1] for x in seq]
        in_ids = [s[i] + r[i] * num_skills for i in range(len(seq) - 1)]
        q_ids = [s[i + 1] for i in range(len(seq) - 1)]
        y_ids = [r[i + 1] for i in range(len(seq) - 1)]

        in_ids, q_ids, y_ids = in_ids[-maxlen:], q_ids[-maxlen:], y_ids[-maxlen:]
        length = len(in_ids)
        pad = maxlen - length
        inter.append(in_ids + [0] * pad)
        query.append(q_ids + [0] * pad)
        target.append(y_ids + [0] * pad)
        mask.append([1] * length + [0] * pad)

    return (
        np.asarray(inter, dtype=np.int64),
        np.asarray(query, dtype=np.int64),
        np.asarray(target, dtype=np.float32),
        np.asarray(mask, dtype=np.float32),
    )
