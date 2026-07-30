/**
 * routes/backoffice/clustering.ts
 *
 * Express endpoints that segment the students of a class into learning
 * profile groups using the pure K-Means engine in `services/clustering`.
 * Results are cached in memory per class for 30 minutes.
 */

import express, { type Request, type Response } from "express";
import mongoose from "mongoose";
import { User } from "../../models/User";
import { StudentProfile } from "../../models/StudentProfile";
import { CurriculumModule } from "../../models/CurriculumModule";
import { ClassRoom } from "../../models/ClassRoom";
import {
  FEATURE_KEYS,
  TOTAL_SUB_ACQUIS,
  computeFeatureVector,
  normalizeFeatures,
  featuresToVector,
  vectorToFeatures,
  averageFeatures,
  type RawStudentData,
  type RawQuizResult,
  type StudentFeatures
} from "../../services/clustering/kmeans";
import { runKMeans } from "../../services/clustering/kmeansClient";
import {
  labelKMeansClusters,
  labelSingleCluster,
  type ClusterProfile
} from "../../services/clustering/clusterLabeler";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export type StudentClusterEntry = {
  identifier: string;
  fullName: string;
  features: StudentFeatures;
  normalizedFeatures: StudentFeatures;
};

/**
 * Count of students in a cluster by their dominant VARK learning style
 * (from `User.varkProfile.dominant`). `unknown` covers students who have
 * not completed the VARK questionnaire. This is an *overlay* on the
 * behavioral clusters, not a clustering feature — it lets a teacher see
 * how a performance group (e.g. "En difficulté") splits by preferred
 * learning style, without mixing preference and performance into one
 * distance metric.
 */
export type VarkBreakdown = {
  visual: number;
  auditory: number;
  readwrite: number;
  kinesthetic: number;
  unknown: number;
  total: number;
};

export type ClusterResult = {
  id: string;
  label: string;
  color: string;
  description: string;
  studentCount: number;
  centroid: StudentFeatures;
  students: StudentClusterEntry[];
  varkBreakdown?: VarkBreakdown;
};

export type ClusteringResponse = {
  classId: string;
  totalStudents: number;
  clusters: ClusterResult[];
  metadata: {
    iterations: number;
    converged: boolean;
    computedAt: string;
  };
};

// ---------------------------------------------------------------------------
// In-memory cache (30 minutes per class)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { data: ClusteringResponse; expiresAt: number }>();

// ---------------------------------------------------------------------------
// Data adaptation: Mongo documents -> RawStudentData
// ---------------------------------------------------------------------------

/**
 * Resolves the live curriculum size (total number of sous-acquis across all
 * modules) to use as the `completionRate` denominator. Falls back to
 * {@link TOTAL_SUB_ACQUIS} if no curriculum data is found.
 */
async function resolveTotalSubAcquis(): Promise<number> {
  const modules = await CurriculumModule.find().select({ acquis: 1 }).lean();
  let count = 0;
  for (const moduleDoc of modules as any[]) {
    for (const acquis of Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : []) {
      count += Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis.length : 0;
    }
  }
  return count > 0 ? count : TOTAL_SUB_ACQUIS;
}

/**
 * Adapts a `StudentProfile` roster entry plus its matching `User` document
 * (progress data) into the `RawStudentData` shape the clustering engine
 * expects.
 *
 * The `User` schema does not currently persist a full per-login timestamp
 * array, so `loginHistory` is approximated from `StudentProfile`'s
 * aggregate `loginCount` / `lastLoginDate` counters: brand-new accounts
 * (`loginCount` 0) correctly yield a `weeklyLoginFrequency` of 0, while
 * returning students get a best-effort recency signal built from their
 * most recent login repeated `loginCount` times. If a true per-login
 * timestamp array is added to the schema in the future, this adapter is
 * the only place that needs to change.
 */
function adaptToRawStudentData(profile: any, user: any | undefined): RawStudentData {
  const progress = user?.progress || {};

  const quizResults: RawQuizResult[] = Array.isArray(progress.quizResults)
    ? progress.quizResults.map((entry: any) => ({
        moduleId: String(entry?.moduleId || ""),
        subAcquisId: String(entry?.subAcquisId || ""),
        score: typeof entry?.score === "number" ? entry.score : Number(entry?.score) || 0,
        submittedAt: entry?.submittedAt || new Date(0),
        attempts: typeof entry?.attempts === "number" ? entry.attempts : undefined
      }))
    : [];

  const loginHistory: string[] = [];
  const loginCount = typeof profile?.loginCount === "number" ? profile.loginCount : 0;
  if (loginCount > 0 && profile?.lastLoginDate) {
    const lastLoginIso = new Date(profile.lastLoginDate).toISOString();
    for (let i = 0; i < loginCount; i++) loginHistory.push(lastLoginIso);
  }

  return {
    identifier: String(profile?.identifier || ""),
    fullName: String(profile?.fullName || profile?.identifier || "Étudiant"),
    completedLessonKeys: Array.isArray(progress.completedLessonKeys) ? progress.completedLessonKeys : [],
    quizResults,
    loginHistory,
    createdAt: user?.createdAt || profile?.createdAt || new Date()
  };
}

// ---------------------------------------------------------------------------
// VARK overlay
// ---------------------------------------------------------------------------

/** Tallies a cluster's students by their dominant VARK style via the lookup map. */
function computeVarkBreakdown(
  students: StudentClusterEntry[],
  varkByIdentifier: Map<string, string>
): VarkBreakdown {
  const breakdown: VarkBreakdown = {
    visual: 0,
    auditory: 0,
    readwrite: 0,
    kinesthetic: 0,
    unknown: 0,
    total: 0
  };
  for (const student of students) {
    breakdown.total += 1;
    const dominant = varkByIdentifier.get(student.identifier);
    if (dominant === "visual") breakdown.visual += 1;
    else if (dominant === "auditory") breakdown.auditory += 1;
    else if (dominant === "readwrite") breakdown.readwrite += 1;
    else if (dominant === "kinesthetic") breakdown.kinesthetic += 1;
    else breakdown.unknown += 1;
  }
  return breakdown;
}

/** Attaches a per-cluster VARK breakdown to every cluster in the response. */
function attachVarkBreakdown(
  response: ClusteringResponse,
  varkByIdentifier: Map<string, string>
): ClusteringResponse {
  for (const cluster of response.clusters) {
    cluster.varkBreakdown = computeVarkBreakdown(cluster.students, varkByIdentifier);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Response assembly
// ---------------------------------------------------------------------------

function buildSingleClusterResponse(
  classId: string,
  rawStudents: RawStudentData[],
  rawFeatures: StudentFeatures[],
  normalizedFeaturesList: StudentFeatures[],
  profile: ClusterProfile,
  metadataOverrides: { iterations: number; converged: boolean }
): ClusteringResponse {
  return {
    classId,
    totalStudents: rawStudents.length,
    clusters:
      rawStudents.length === 0
        ? []
        : [
            {
              id: profile.id,
              label: profile.label,
              color: profile.color,
              description: profile.description,
              studentCount: rawStudents.length,
              centroid: averageFeatures(normalizedFeaturesList),
              students: rawStudents.map((student, index) => ({
                identifier: student.identifier,
                fullName: student.fullName,
                features: rawFeatures[index],
                normalizedFeatures: normalizedFeaturesList[index]
              }))
            }
          ],
    metadata: {
      iterations: metadataOverrides.iterations,
      converged: metadataOverrides.converged,
      computedAt: new Date().toISOString()
    }
  };
}

/**
 * Fetches a class roster, computes each student's feature vector, runs
 * K-Means (or the appropriate single-cluster fallback), and assembles the
 * full clustering response. This is the single source of truth used by
 * both the cached GET endpoint and the cache-busting refresh endpoint.
 *
 * @param classId - the ClassRoom `_id` to segment.
 * @returns the assembled clustering response for that class.
 */
async function computeClusteringForClass(classId: string): Promise<ClusteringResponse> {
  const roster = await StudentProfile.find({ classId })
    .select({ identifier: 1, fullName: 1, loginCount: 1, lastLoginDate: 1, createdAt: 1 })
    .lean();

  if (roster.length === 0) {
    return {
      classId,
      totalStudents: 0,
      clusters: [],
      metadata: { iterations: 0, converged: true, computedAt: new Date().toISOString() }
    };
  }

  const identifiers = roster.map((student: any) => student.identifier).filter(Boolean);
  const users = identifiers.length
    ? await User.find({ identifier: { $in: identifiers } })
        .select({ identifier: 1, progress: 1, varkProfile: 1, createdAt: 1 })
        .lean()
    : [];
  const userByIdentifier = new Map(users.map((user: any) => [user.identifier, user]));

  // Dominant VARK style per student, for the learning-style overlay on each cluster.
  const varkByIdentifier = new Map<string, string>();
  for (const user of users as any[]) {
    const dominant = user?.varkProfile?.dominant;
    if (user?.identifier && dominant) varkByIdentifier.set(String(user.identifier), String(dominant));
  }

  const totalSubAcquis = await resolveTotalSubAcquis();
  const now = new Date();

  const rawStudents = roster.map((profile: any) =>
    adaptToRawStudentData(profile, userByIdentifier.get(profile.identifier))
  );
  const rawFeatures = rawStudents.map((student) => computeFeatureVector(student, { totalSubAcquis, now }));

  // Edge case: fewer than 3 students -> a single "Groupe unique" cluster, no K-Means run.
  if (roster.length < 3) {
    const profile = labelSingleCluster("too-few-students");
    return attachVarkBreakdown(
      buildSingleClusterResponse(classId, rawStudents, rawFeatures, rawFeatures, profile, {
        iterations: 0,
        converged: true
      }),
      varkByIdentifier
    );
  }

  const { normalized, hasVariance } = normalizeFeatures(rawFeatures);

  // Edge case: every student has an identical feature vector -> single cluster B, no K-Means run.
  if (!hasVariance) {
    const profile = labelSingleCluster("no-variance");
    return attachVarkBreakdown(
      buildSingleClusterResponse(classId, rawStudents, rawFeatures, normalized, profile, {
        iterations: 0,
        converged: true
      }),
      varkByIdentifier
    );
  }

  const points = normalized.map(featuresToVector);
  const { assignments, centroids, iterations, converged } = await runKMeans(points, 3);
  const centroidFeatures = centroids.map(vectorToFeatures);
  const profiles = labelKMeansClusters(centroidFeatures);

  const clusters: ClusterResult[] = profiles.map((profile, clusterIndex) => {
    const studentIndexes = assignments
      .map((assignedIndex, i) => (assignedIndex === clusterIndex ? i : -1))
      .filter((i) => i >= 0);

    return {
      id: profile.id,
      label: profile.label,
      color: profile.color,
      description: profile.description,
      studentCount: studentIndexes.length,
      centroid: centroidFeatures[clusterIndex],
      students: studentIndexes.map((i) => ({
        identifier: rawStudents[i].identifier,
        fullName: rawStudents[i].fullName,
        features: rawFeatures[i],
        normalizedFeatures: normalized[i]
      }))
    };
  });

  return attachVarkBreakdown(
    {
      classId,
      totalStudents: roster.length,
      clusters,
      metadata: { iterations, converged, computedAt: now.toISOString() }
    },
    varkByIdentifier
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const clusteringRouter = express.Router();

/**
 * The /api/backoffice guard only proves the caller is SOME teacher/admin — it
 * doesn't scope them to this class. Without this, any teacher could read/refresh
 * any other teacher's class clustering by supplying a different classId.
 * Returns true (and has already sent a 403) when the request should stop here.
 */
async function classAccessDenied(req: Request, res: Response, classId: string): Promise<boolean> {
  if (req.auth?.role === "admin") return false;
  const classRoom = await ClassRoom.findById(classId).select({ teacherId: 1 }).lean();
  if (!classRoom || String((classRoom as any).teacherId || "") !== (req.auth?.id ?? "")) {
    res.status(403).json({ message: "Accès non autorisé à cette classe" });
    return true;
  }
  return false;
}

/**
 * GET /api/backoffice/clustering/:classId
 *
 * Returns the cached clustering result for the class if it was computed
 * less than 30 minutes ago, otherwise recomputes it and caches the result.
 */
clusteringRouter.get("/api/backoffice/clustering/:classId", async (req: Request, res: Response) => {
  try {
    const classId = String(req.params.classId || "").trim();
    if (!classId) {
      return res.status(400).json({ message: "classId est requis" });
    }
    if (!mongoose.isValidObjectId(classId)) {
      return res.status(400).json({ message: "classId invalide" });
    }
    if (await classAccessDenied(req, res, classId)) return;

    const cached = cache.get(classId);
    if (cached && cached.expiresAt > Date.now()) {
      return res.status(200).json(cached.data);
    }

    const data = await computeClusteringForClass(classId);
    cache.set(classId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return res.status(200).json(data);
  } catch (error) {
    console.error("Failed to compute student clustering:", error);
    return res.status(500).json({ message: "Impossible de calculer le clustering des étudiants" });
  }
});

/**
 * POST /api/backoffice/clustering/:classId/refresh
 *
 * Clears the cached clustering result for the class (if any) and
 * recomputes it immediately.
 */
clusteringRouter.post("/api/backoffice/clustering/:classId/refresh", async (req: Request, res: Response) => {
  try {
    const classId = String(req.params.classId || "").trim();
    if (!classId) {
      return res.status(400).json({ message: "classId est requis" });
    }
    if (!mongoose.isValidObjectId(classId)) {
      return res.status(400).json({ message: "classId invalide" });
    }
    if (await classAccessDenied(req, res, classId)) return;

    cache.delete(classId);
    const data = await computeClusteringForClass(classId);
    cache.set(classId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return res.status(200).json(data);
  } catch (error) {
    console.error("Failed to refresh student clustering:", error);
    return res.status(500).json({ message: "Impossible de rafraîchir le clustering des étudiants" });
  }
});

// Re-exported for callers that only need the feature-key ordering (e.g. tests or tooling).
export { FEATURE_KEYS };
