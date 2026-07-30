/**
 * routes/backoffice/attention.ts
 *
 * Per-class attention summaries for the backoffice dashboard. Aggregates the
 * attention sessions stored on each student's progress by
 * POST /api/student/attention-session.
 */

import express, { type Request, type Response } from "express";
import mongoose from "mongoose";
import { User } from "../../models/User";
import { StudentProfile } from "../../models/StudentProfile";
import { ClassRoom } from "../../models/ClassRoom";
import { computeAttentionAnalytics } from "../../services/attention/attentionClient";
import { isOwnedByCaller } from "../../services/classAccess";

export const attentionRouter = express.Router();

/** Sessions included per student for the detail panel / heatmap. */
const RECENT_SESSIONS = 10;

type StoredSession = {
  sessionId?: string;
  context?: string;
  moduleId?: string;
  subAcquisId?: string;
  duration?: number;
  avgFocusScore?: number;
  minFocusScore?: number;
  distractionEvents?: Array<{ t: number; reason: string; duration: number }>;
  focusTimeline?: Array<{ t: number; score: number }>;
  completedAt?: Date | string;
};

/**
 * GET /api/backoffice/attention/:classId
 *
 * Returns attention summaries for every student of the class, sorted by
 * average focus ascending (struggling students first). Students without any
 * attention sessions are included with null metrics so teachers can see who
 * has the feature disabled.
 */
attentionRouter.get("/api/backoffice/attention/:classId", async (req: Request, res: Response) => {
  try {
    const classId = String(req.params.classId || "").trim();
    if (!classId) {
      return res.status(400).json({ message: "classId est requis" });
    }
    if (!mongoose.isValidObjectId(classId)) {
      return res.status(400).json({ message: "classId invalide" });
    }

    // The /api/backoffice guard only proves the caller is SOME teacher/admin —
    // it doesn't scope them to this class. Without this check, any teacher
    // could read any other teacher's class attention analytics by supplying a
    // different classId.
    if (req.auth?.role !== "admin") {
      const classRoom = await ClassRoom.findById(classId).select({ teacherId: 1 }).lean();
      if (!classRoom || !isOwnedByCaller((classRoom as any).teacherId, req.auth)) {
        return res.status(403).json({ message: "Accès non autorisé à cette classe" });
      }
    }

    const roster = await StudentProfile.find({ classId }).select({ identifier: 1, fullName: 1 }).lean();
    if (roster.length === 0) {
      return res.status(200).json({ classId, students: [] });
    }

    const identifiers = roster.map((p: any) => p.identifier).filter(Boolean);
    const users = await User.find({ identifier: { $in: identifiers } })
      .select({ identifier: 1, "progress.attentionSessions": 1, "progress.avgFocusScore": 1 })
      .lean();
    const userByIdentifier = new Map(users.map((u: any) => [u.identifier, u]));

    // Sort each student's sessions chronologically once.
    const sessionsPerStudent: StoredSession[][] = roster.map((profile: any) => {
      const user: any = userByIdentifier.get(profile.identifier);
      return Array.isArray(user?.progress?.attentionSessions)
        ? [...user.progress.attentionSessions].sort(
            (a: StoredSession, b: StoredSession) =>
              new Date(a.completedAt || 0).getTime() - new Date(b.completedAt || 0).getTime()
          )
        : [];
    });

    // Trend + top-distraction are computed by the Python service over DERIVED
    // metrics only (per-session scores + distraction reason codes) — one call for
    // the whole class. No frames or landmarks are ever involved.
    const analytics = await computeAttentionAnalytics(
      sessionsPerStudent.map((sessions) => ({
        avgScores: sessions.map((s) => Number(s.avgFocusScore) || 0),
        distractions: sessions
          .flatMap((s) => (Array.isArray(s.distractionEvents) ? s.distractionEvents : []))
          .map((e) => String(e?.reason || ""))
          .filter(Boolean)
      }))
    );

    const students = roster.map((profile: any, i: number) => {
      const user: any = userByIdentifier.get(profile.identifier);
      const sessions = sessionsPerStudent[i];
      const last = sessions.length ? sessions[sessions.length - 1] : null;

      return {
        identifier: String(profile.identifier || ""),
        fullName: String(profile.fullName || profile.identifier || "Étudiant"),
        avgFocusScore: sessions.length ? Number(user?.progress?.avgFocusScore ?? null) : null,
        totalSessions: sessions.length,
        lastSession: last
          ? {
              avgFocusScore: Number(last.avgFocusScore) || 0,
              context: String(last.context || "lesson"),
              completedAt: last.completedAt ? new Date(last.completedAt).toISOString() : null
            }
          : null,
        trend: analytics[i].trend,
        topDistraction: analytics[i].topDistraction,
        // Recent sessions power the detail panel charts + heatmap client-side.
        recentSessions: sessions.slice(-RECENT_SESSIONS).map((s) => ({
          sessionId: String(s.sessionId || ""),
          context: String(s.context || "lesson"),
          moduleId: String(s.moduleId || ""),
          subAcquisId: String(s.subAcquisId || ""),
          duration: Number(s.duration) || 0,
          avgFocusScore: Number(s.avgFocusScore) || 0,
          minFocusScore: Number(s.minFocusScore) || 0,
          distractionEvents: Array.isArray(s.distractionEvents) ? s.distractionEvents : [],
          focusTimeline: Array.isArray(s.focusTimeline) ? s.focusTimeline : [],
          completedAt: s.completedAt ? new Date(s.completedAt).toISOString() : null
        }))
      };
    });

    students.sort((a, b) => (a.avgFocusScore ?? 101) - (b.avgFocusScore ?? 101));

    return res.status(200).json({ classId, students });
  } catch (error) {
    console.error("Failed to compute attention summaries:", error);
    return res.status(500).json({ message: "Impossible de récupérer les données d'attention" });
  }
});
