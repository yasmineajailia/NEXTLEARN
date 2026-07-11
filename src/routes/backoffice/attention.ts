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
 * Computes the focus trend by comparing the average of the last 3 sessions
 * with the previous 3: "improving" if delta > 5, "declining" if delta < -5,
 * "stable" otherwise (including when there aren't 6 sessions yet).
 *
 * @param sessions - the student's sessions in chronological order.
 */
function computeTrend(sessions: StoredSession[]): "improving" | "declining" | "stable" {
  if (sessions.length < 6) return "stable";
  const score = (s: StoredSession) => Number(s.avgFocusScore) || 0;
  const last3 = sessions.slice(-3);
  const prev3 = sessions.slice(-6, -3);
  const avg = (list: StoredSession[]) => list.reduce((sum, s) => sum + score(s), 0) / list.length;
  const delta = avg(last3) - avg(prev3);
  if (delta > 5) return "improving";
  if (delta < -5) return "declining";
  return "stable";
}

/**
 * Finds the most frequent distraction reason across all of a student's
 * sessions (weighted by event count, not duration).
 *
 * @param sessions - the student's sessions.
 * @returns the reason string, or null if the student has no distraction events.
 */
function computeTopDistraction(sessions: StoredSession[]): string | null {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    for (const event of Array.isArray(session.distractionEvents) ? session.distractionEvents : []) {
      const reason = String(event?.reason || "");
      if (!reason) continue;
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
  }
  let top: string | null = null;
  let max = 0;
  for (const [reason, count] of counts) {
    if (count > max) {
      max = count;
      top = reason;
    }
  }
  return top;
}

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

    const roster = await StudentProfile.find({ classId }).select({ identifier: 1, fullName: 1 }).lean();
    if (roster.length === 0) {
      return res.status(200).json({ classId, students: [] });
    }

    const identifiers = roster.map((p: any) => p.identifier).filter(Boolean);
    const users = await User.find({ identifier: { $in: identifiers } })
      .select({ identifier: 1, "progress.attentionSessions": 1, "progress.avgFocusScore": 1 })
      .lean();
    const userByIdentifier = new Map(users.map((u: any) => [u.identifier, u]));

    const students = roster.map((profile: any) => {
      const user: any = userByIdentifier.get(profile.identifier);
      const sessions: StoredSession[] = Array.isArray(user?.progress?.attentionSessions)
        ? [...user.progress.attentionSessions].sort(
            (a: StoredSession, b: StoredSession) =>
              new Date(a.completedAt || 0).getTime() - new Date(b.completedAt || 0).getTime()
          )
        : [];

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
        trend: computeTrend(sessions),
        topDistraction: computeTopDistraction(sessions),
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
