/**
 * clusterLabeler.ts
 *
 * Turns anonymous K-Means centroid indices into the business-facing cluster
 * profiles ("Avancés" / "En progression" / "En difficulté") shown to
 * teachers in the backoffice. Contains no MongoDB or Express dependencies.
 */

import type { StudentFeatures } from "./kmeans";

export type ClusterId = "A" | "B" | "C" | "single";

/** A human-facing description of a cluster, independent of which centroid produced it. */
export type ClusterProfile = {
  id: ClusterId;
  label: string;
  color: string;
  description: string;
};

export const CLUSTER_PROFILE_A: ClusterProfile = {
  id: "A",
  label: "Avancés",
  color: "#1d9e75",
  description: "Étudiants avec une progression rapide et de bons résultats aux quiz"
};

export const CLUSTER_PROFILE_B: ClusterProfile = {
  id: "B",
  label: "En progression",
  color: "#f59e0b",
  description: "Étudiants avec une progression régulière mais des marges d'amélioration"
};

export const CLUSTER_PROFILE_C: ClusterProfile = {
  id: "C",
  label: "En difficulté",
  color: "#c41d38",
  description: "Étudiants nécessitant un accompagnement prioritaire"
};

/** Used when clustering is skipped because the class has fewer than 3 students. */
export const SINGLE_GROUP_PROFILE: ClusterProfile = {
  id: "single",
  label: "Groupe unique",
  color: "#6b7280",
  description: "Effectif trop réduit pour distinguer plusieurs profils d'apprentissage"
};

/**
 * Labels the 3 centroids produced by K-Means (K is fixed at 3 for this
 * module) into the "Avancés" / "En progression" / "En difficulté" business
 * profiles.
 *
 * A composite score `(completionRate + avgQuizScore) / 2` — both already
 * expressed on the same normalized [0, 1] scale — ranks the three
 * centroids. This makes the "highest avgQuizScore AND highest
 * completionRate" rule deterministic even when no single centroid strictly
 * leads on both metrics individually: the top-ranked centroid becomes
 * "Avancés", the bottom-ranked becomes "En difficulté", and the remaining
 * one becomes "En progression".
 *
 * @param centroids - exactly 3 centroids, expressed as normalized StudentFeatures (each dimension in [0, 1]).
 * @returns one ClusterProfile per input centroid, in the same order/index as `centroids`.
 * @throws if `centroids` does not contain exactly 3 entries.
 */
export function labelKMeansClusters(centroids: StudentFeatures[]): ClusterProfile[] {
  if (centroids.length !== 3) {
    throw new Error(`labelKMeansClusters expects exactly 3 centroids, received ${centroids.length}`);
  }

  const compositeScores = centroids.map((centroid) => {
    const completion = Number.isFinite(centroid.completionRate) ? centroid.completionRate : 0;
    const quiz = Number.isFinite(centroid.avgQuizScore) ? centroid.avgQuizScore : 0;
    return (completion + quiz) / 2;
  });

  const ranked = compositeScores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score);

  const profileByCentroidIndex: ClusterProfile[] = new Array(3);
  profileByCentroidIndex[ranked[0].index] = CLUSTER_PROFILE_A;
  profileByCentroidIndex[ranked[1].index] = CLUSTER_PROFILE_B;
  profileByCentroidIndex[ranked[2].index] = CLUSTER_PROFILE_C;

  return profileByCentroidIndex;
}

/**
 * Returns the profile to use when K-Means is skipped entirely: either the
 * class has fewer than 3 students, or every student produced an identical
 * (zero-variance) feature vector.
 *
 * @param reason - `"too-few-students"` yields the neutral "Groupe unique" label;
 *   `"no-variance"` reuses the "En progression" (cluster B) label, per spec.
 */
export function labelSingleCluster(reason: "too-few-students" | "no-variance"): ClusterProfile {
  return reason === "no-variance" ? CLUSTER_PROFILE_B : SINGLE_GROUP_PROFILE;
}
