"""
routers/clustering.py

K-Means learning-profile segmentation over normalized student feature vectors.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from sklearn.cluster import KMeans
import numpy as np

router = APIRouter()


class ClusterBody(BaseModel):
    """Normalized student points to segment into k learning-profile clusters."""
    points: list[list[float]]
    k: int = 3


@router.post("/cluster")
def cluster(body: ClusterBody):
    """K-Means over normalized student vectors (learning-profile segmentation)."""
    pts = np.asarray(body.points, dtype=float)
    n = len(pts)
    if n == 0:
        return {"assignments": [], "centroids": [], "iterations": 0, "converged": True}
    k = max(1, min(int(body.k), n))
    max_iter = 100
    km = KMeans(n_clusters=k, n_init=10, max_iter=max_iter, random_state=42)
    labels = km.fit_predict(pts)
    return {
        "assignments": labels.astype(int).tolist(),
        "centroids": km.cluster_centers_.tolist(),
        "iterations": int(km.n_iter_),
        "converged": bool(km.n_iter_ < max_iter),
    }
