"""
train_sakt.py — train + evaluate the SAKT knowledge-tracing model on OULAD.

Run:  python ml/kt/train_sakt.py

- Splits by STUDENT (each sequence is one student) into train/val/test, so no
  student appears in two splits — a leakage-free evaluation.
- Trains with masked binary cross-entropy on next-response prediction.
- Early-stops on validation AUC, then reports TEST AUC + accuracy (never train).
- Saves the weights + config + skill vocabulary to ml/models/kt-sakt.pt.
"""
from __future__ import annotations

import json
import os
import random

import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import accuracy_score, roc_auc_score
from torch.utils.data import DataLoader, TensorDataset

try:  # works both as a script (python ml/kt/train_sakt.py) and as a module
    from .kt_data import load_oulad_sequences, to_tensors
    from .sakt import SAKT
except ImportError:  # pragma: no cover
    from kt_data import load_oulad_sequences, to_tensors
    from sakt import SAKT

SEED = 42
MAXLEN = 50
D_MODEL = 64
N_HEADS = 4
DROPOUT = 0.2
BATCH = 256
EPOCHS = 40
PATIENCE = 5
LR = 1e-3
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "kt-sakt.pt")


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def split_sequences(sequences, seed=SEED):
    rng = random.Random(seed)
    seqs = sequences[:]
    rng.shuffle(seqs)
    n = len(seqs)
    n_test = int(n * 0.15)
    n_val = int(n * 0.15)
    test = seqs[:n_test]
    val = seqs[n_test:n_test + n_val]
    train = seqs[n_test + n_val:]
    return train, val, test


def make_loader(sequences, num_skills, shuffle):
    inter, query, target, mask = to_tensors(sequences, num_skills, MAXLEN)
    ds = TensorDataset(
        torch.from_numpy(inter), torch.from_numpy(query),
        torch.from_numpy(target), torch.from_numpy(mask),
    )
    return DataLoader(ds, batch_size=BATCH, shuffle=shuffle)


@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    ys, ps = [], []
    for inter, query, target, mask in loader:
        inter, query = inter.to(device), query.to(device)
        logits = model(inter, query).cpu()
        m = mask.bool()
        ps.append(torch.sigmoid(logits[m]).numpy())
        ys.append(target[m].numpy())
    y = np.concatenate(ys)
    p = np.concatenate(ps)
    auc = roc_auc_score(y, p)
    acc = accuracy_score(y, (p >= 0.5).astype(int))
    return auc, acc


def main():
    set_seed(SEED)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device}")

    sequences, skill2idx = load_oulad_sequences()
    num_skills = len(skill2idx)
    print(f"students (sequences): {len(sequences)} | skills: {num_skills}")

    train, val, test = split_sequences(sequences)
    print(f"split -> train {len(train)} | val {len(val)} | test {len(test)}")

    train_loader = make_loader(train, num_skills, shuffle=True)
    val_loader = make_loader(val, num_skills, shuffle=False)
    test_loader = make_loader(test, num_skills, shuffle=False)

    model = SAKT(num_skills, MAXLEN, D_MODEL, N_HEADS, DROPOUT).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    loss_fn = nn.BCEWithLogitsLoss(reduction="none")

    best_auc, best_state, since = 0.0, None, 0
    for epoch in range(1, EPOCHS + 1):
        model.train()
        total = 0.0
        for inter, query, target, mask in train_loader:
            inter, query = inter.to(device), query.to(device)
            target, mask = target.to(device), mask.to(device)
            opt.zero_grad()
            logits = model(inter, query)
            loss = loss_fn(logits, target) * mask
            loss = loss.sum() / mask.sum()
            loss.backward()
            opt.step()
            total += loss.item()
        val_auc, val_acc = evaluate(model, val_loader, device)
        print(f"epoch {epoch:02d} | train loss {total/len(train_loader):.4f} "
              f"| val AUC {val_auc:.4f} acc {val_acc:.4f}")
        if val_auc > best_auc:
            best_auc, since = val_auc, 0
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
        else:
            since += 1
            if since >= PATIENCE:
                print(f"early stop at epoch {epoch} (best val AUC {best_auc:.4f})")
                break

    model.load_state_dict(best_state)
    test_auc, test_acc = evaluate(model, test_loader, device)
    # Majority-class baseline for context (what accuracy a trivial guess reaches).
    _, _, y_test, m_test = to_tensors(test, num_skills, MAXLEN)
    base_rate = y_test[m_test.astype(bool)].mean()
    print("\n==== TEST (held-out students) ====")
    print(f"AUC {test_auc:.4f} | accuracy {test_acc:.4f} | positive rate {base_rate:.4f}")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    torch.save(
        {
            "state_dict": best_state,
            "config": {"num_skills": num_skills, "maxlen": MAXLEN,
                       "d_model": D_MODEL, "n_heads": N_HEADS, "dropout": DROPOUT},
            "skill2idx": skill2idx,
            "test_auc": float(test_auc), "test_acc": float(test_acc),
        },
        os.path.normpath(OUT_PATH),
    )
    print(f"saved -> {os.path.normpath(OUT_PATH)}")
    # Sidecar JSON so the vocab is inspectable without loading torch.
    with open(os.path.normpath(OUT_PATH).replace(".pt", "-vocab.json"), "w") as f:
        json.dump({"skill2idx": skill2idx, "num_skills": num_skills}, f)


if __name__ == "__main__":
    main()
