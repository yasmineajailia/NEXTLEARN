/**
 * routes/student/attentionSession.ts
 *
 * Receives attention-tracking session summaries computed CLIENT-SIDE by
 * public/student/js/attentionTracker.js. Only derived numeric metrics ever
 * reach this endpoint — no video frames or images exist server-side by design.
 */

import express, { type Request, type Response } from "express";
import { User } from "../../models/User";

export const attentionSessionRouter = express.Router();

const VALID_CONTEXTS = new Set(["lesson", "quiz"]);
const VALID_REASONS = new Set(["eyes_closed", "head_turned", "gaze_away", "no_face"]);

/** Number of most-recent sessions used for the student's rolling average. */
const ROLLING_WINDOW = 10;

/**
 * Sanitizes a client-supplied distraction-event list into the persisted shape.
 * Unknown reasons and malformed entries are dropped rather than rejected, so a
 * slightly out-of-date client can't fail the whole session save.
 *
 * @param raw - the request body's `distractionEvents` value.
 * @returns a clean array safe to persist.
 */
function sanitizeDistractionEvents(raw: unknown): Array<{ t: number; reason: string; duration: number }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e: any) => ({
      t: Number(e?.t),
      reason: String(e?.reason || ""),
      duration: Number(e?.duration)
    }))
    .filter((e) => Number.isFinite(e.t) && e.t >= 0 && Number.isFinite(e.duration) && e.duration >= 0 && VALID_REASONS.has(e.reason))
    .slice(0, 500);
}

/**
 * Sanitizes the focus timeline samples ({ t, score } every 5 seconds).
 *
 * @param raw - the request body's `focusTimeline` value.
 * @returns a clean array safe to persist.
 */
function sanitizeTimeline(raw: unknown): Array<{ t: number; score: number }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s: any) => ({ t: Number(s?.t), score: Math.round(Number(s?.score)) }))
    .filter((s) => Number.isFinite(s.t) && s.t >= 0 && Number.isFinite(s.score) && s.score >= 0 && s.score <= 100)
    .slice(0, 5000);
}

/**
 * POST /api/student/attention-session
 *
 * Validates and stores one attention session summary on the student's
 * progress, then recomputes the rolling average focus score over the last
 * {@link ROLLING_WINDOW} sessions.
 */
attentionSessionRouter.post("/api/student/attention-session", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};

    const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
    if (!identifier) {
      return res.status(400).json({ message: "Identifiant requis" });
    }

    const duration = Number(body.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      return res.status(400).json({ message: "duration doit être un nombre positif" });
    }

    const avgFocusScore = Number(body.avgFocusScore);
    if (!Number.isFinite(avgFocusScore) || avgFocusScore < 0 || avgFocusScore > 100) {
      return res.status(400).json({ message: "avgFocusScore doit être entre 0 et 100" });
    }

    const context = VALID_CONTEXTS.has(String(body.context)) ? String(body.context) : "lesson";
    const minFocusScoreRaw = Number(body.minFocusScore);
    const minFocusScore =
      Number.isFinite(minFocusScoreRaw) && minFocusScoreRaw >= 0 && minFocusScoreRaw <= 100
        ? Math.round(minFocusScoreRaw)
        : Math.round(avgFocusScore);

    const completedAtRaw = body.completedAt ? new Date(String(body.completedAt)) : new Date();
    const completedAt = Number.isNaN(completedAtRaw.getTime()) ? new Date() : completedAtRaw;

    const user = await User.findOne({ identifier });
    if (!user) {
      return res.status(404).json({ message: "Étudiant introuvable" });
    }

    const progress: any = (user as any).progress || {};
    const sessions: any[] = Array.isArray(progress.attentionSessions) ? progress.attentionSessions : [];

    sessions.push({
      sessionId: String(body.sessionId || `att-${Date.now()}`),
      context,
      moduleId: typeof body.moduleId === "string" ? body.moduleId : "",
      subAcquisId: typeof body.subAcquisId === "string" ? body.subAcquisId : "",
      duration: Math.round(duration),
      avgFocusScore: Math.round(avgFocusScore),
      minFocusScore,
      distractionEvents: sanitizeDistractionEvents(body.distractionEvents),
      focusTimeline: sanitizeTimeline(body.focusTimeline),
      completedAt
    });

    // Rolling average of the last N sessions.
    const lastN = sessions.slice(-ROLLING_WINDOW);
    const rollingAvg = Math.round(lastN.reduce((sum, s) => sum + (Number(s.avgFocusScore) || 0), 0) / lastN.length);

    (user as any).progress = { ...progress, attentionSessions: sessions, avgFocusScore: rollingAvg };
    (user as any).markModified("progress");
    await user.save();

    return res.status(200).json({ success: true, avgFocusScore: rollingAvg });
  } catch (error) {
    console.error("Failed to save attention session:", error);
    return res.status(500).json({ message: "Impossible d'enregistrer la session d'attention" });
  }
});
