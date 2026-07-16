/**
 * kmeansClient.ts
 *
 * K-Means clustering runs in the Python ML service (scikit-learn, `POST /cluster`).
 * This thin client posts the normalized student vectors and returns the cluster
 * assignments + centroids. Feature engineering, normalization and cluster
 * labeling stay in Node (`kmeans.ts`, `clusterLabeler.ts`) — only the clustering
 * math moved. There is no JS fallback; the service is supervised.
 */
import {
  SHAP_SERVICE_URL,
  SHAP_SERVICE_TIMEOUT_MS,
  markShapServiceUp,
  markShapServiceDown
} from "../prediction/explain";

export type KMeansResult = {
  /** `assignments[i]` is the cluster index (0-based) assigned to `points[i]`. */
  assignments: number[];
  centroids: number[][];
  iterations: number;
  converged: boolean;
};

/** Segments `points` into `k` clusters via the Python service. Throws if unavailable. */
export async function runKMeans(points: number[][], k: number): Promise<KMeansResult> {
  if (points.length === 0 || k <= 0) {
    return { assignments: [], centroids: [], iterations: 0, converged: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHAP_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SHAP_SERVICE_URL.replace(/\/$/, "")}/cluster`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points, k }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`ML service /cluster -> ${res.status}`);
    const data = (await res.json()) as Partial<KMeansResult>;
    if (!Array.isArray(data.assignments) || !Array.isArray(data.centroids)) {
      throw new Error("malformed /cluster payload");
    }
    markShapServiceUp();
    return {
      assignments: data.assignments,
      centroids: data.centroids,
      iterations: typeof data.iterations === "number" ? data.iterations : 0,
      converged: Boolean(data.converged)
    };
  } catch (err) {
    markShapServiceDown();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
