/**
 * routes/backoffice/vark.ts
 *
 * Per-class VARK learning-style analytics for the backoffice. Aggregates the
 * persisted `varkProfile` stored on each student's User document by
 * POST /api/student/vark, so teachers can see the learning-style makeup of a
 * class (and who hasn't taken the "Mission Apprenant" game yet).
 */

import express, { type Request, type Response } from "express";
import mongoose from "mongoose";
import { User } from "../../models/User";
import { StudentProfile } from "../../models/StudentProfile";
import { ClassRoom } from "../../models/ClassRoom";

export const varkRouter = express.Router();

const DIMS = ["visual", "readwrite", "auditory", "kinesthetic"] as const;
type Dim = (typeof DIMS)[number];

/**
 * GET /api/backoffice/vark/:classId
 *
 * Returns the distribution of dominant VARK styles across a class, plus a
 * per-student breakdown. Students who have not taken the test yet are counted
 * in `notTaken` and listed with `dominant: null`.
 */
varkRouter.get("/api/backoffice/vark/:classId", async (req: Request, res: Response) => {
  try {
    const classId = String(req.params.classId || "").trim();
    if (!classId) {
      return res.status(400).json({ message: "classId est requis" });
    }
    if (!mongoose.isValidObjectId(classId)) {
      return res.status(400).json({ message: "classId invalide" });
    }

    // Same ownership check as attention.ts: the /api/backoffice guard only
    // proves the caller is A teacher, not THIS class's teacher.
    if (req.auth?.role !== "admin") {
      const classRoom = await ClassRoom.findById(classId).select({ teacherId: 1 }).lean();
      if (!classRoom || String((classRoom as any).teacherId || "") !== (req.auth?.id ?? "")) {
        return res.status(403).json({ message: "Accès non autorisé à cette classe" });
      }
    }

    const emptyDistribution: Record<Dim, number> = { visual: 0, readwrite: 0, auditory: 0, kinesthetic: 0 };

    const roster = await StudentProfile.find({ classId }).select({ identifier: 1, fullName: 1 }).lean();
    if (roster.length === 0) {
      return res
        .status(200)
        .json({ classId, total: 0, taken: 0, notTaken: 0, distribution: emptyDistribution, students: [] });
    }

    const identifiers = roster.map((p: any) => p.identifier).filter(Boolean);
    const users = await User.find({ identifier: { $in: identifiers } })
      .select({ identifier: 1, varkProfile: 1 })
      .lean();
    const userByIdentifier = new Map(users.map((u: any) => [u.identifier, u]));

    const distribution: Record<Dim, number> = { ...emptyDistribution };
    let taken = 0;

    const students = roster.map((profile: any) => {
      const user: any = userByIdentifier.get(profile.identifier);
      const dominant = user?.varkProfile?.dominant;
      const valid = typeof dominant === "string" && (DIMS as readonly string[]).includes(dominant);
      if (valid) {
        distribution[dominant as Dim] += 1;
        taken += 1;
      }
      return {
        identifier: String(profile.identifier || ""),
        fullName: String(profile.fullName || profile.identifier || "Étudiant"),
        dominant: valid ? (dominant as Dim) : null,
        scores: valid ? user.varkProfile.scores : null,
        completedAt: user?.varkProfile?.completedAt ? new Date(user.varkProfile.completedAt).toISOString() : null
      };
    });

    return res.status(200).json({
      classId,
      total: roster.length,
      taken,
      notTaken: roster.length - taken,
      distribution,
      students
    });
  } catch (error) {
    console.error("Failed to compute VARK distribution:", error);
    return res.status(500).json({ message: "Impossible de récupérer les profils VARK" });
  }
});
