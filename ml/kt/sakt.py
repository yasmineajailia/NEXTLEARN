"""
sakt.py — Self-Attentive Knowledge Tracing (Pandey & Karypis, 2019).

A single self-attention block: past interactions (skill + response) are the
keys/values, the queried skill is the query, and a causal mask enforces that
each prediction sees only earlier interactions. The output is P(correct) for the
queried skill — used as the training target during learning and, at serving
time, as the student's *mastery* estimate for that skill.

Why attention over an RNN (DKT): SAKT weighs which past interactions are
relevant to the current skill instead of compressing everything into one hidden
state, which both tends to score better and gives an interpretable attention map.
"""
from __future__ import annotations

import torch
import torch.nn as nn


class SAKT(nn.Module):
    def __init__(
        self,
        num_skills: int,
        maxlen: int = 50,
        d_model: int = 64,
        n_heads: int = 4,
        dropout: float = 0.2,
    ):
        super().__init__()
        self.num_skills = num_skills
        self.maxlen = maxlen
        # Interaction embedding spans 2*num_skills (skill x {wrong,right}); +1 pad@0.
        self.inter_emb = nn.Embedding(2 * num_skills + 1, d_model, padding_idx=0)
        # Query embedding is over skills only (the skill being asked); +1 pad@0.
        self.skill_emb = nn.Embedding(num_skills + 1, d_model, padding_idx=0)
        self.pos_emb = nn.Embedding(maxlen, d_model)
        self.attn = nn.MultiheadAttention(d_model, n_heads, dropout=dropout, batch_first=True)
        self.ln1 = nn.LayerNorm(d_model)
        self.ffn = nn.Sequential(
            nn.Linear(d_model, d_model),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(d_model, d_model),
        )
        self.ln2 = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)
        self.out = nn.Linear(d_model, 1)

    def forward(self, inter: torch.Tensor, query: torch.Tensor) -> torch.Tensor:
        """inter, query: ``[B, L]`` long tensors. Returns ``[B, L]`` logits."""
        _b, length = inter.shape
        pos = torch.arange(length, device=inter.device).unsqueeze(0)
        keys = self.inter_emb(inter) + self.pos_emb(pos)   # past interactions
        queries = self.skill_emb(query)                     # skill being predicted
        # Causal mask: query i may attend interactions 0..i (strictly-future masked).
        causal = torch.triu(
            torch.ones(length, length, device=inter.device, dtype=torch.bool), diagonal=1
        )
        key_pad = inter == 0  # [B, L] — don't attend padded interactions
        att, _ = self.attn(queries, keys, keys, attn_mask=causal, key_padding_mask=key_pad)
        x = self.ln1(queries + self.dropout(att))
        x = self.ln2(x + self.dropout(self.ffn(x)))
        return self.out(x).squeeze(-1)  # logits; apply sigmoid for P(correct)
