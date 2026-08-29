/**
 * Student mastery + revision route.
 *
 * Thin wrapper: identity is fixed to the caller's own session
 * (req.auth.id), so a student can only ever ask for their own mastery. The
 * actual computation lives in services/mastery/masterySummary.ts, shared
 * with the teacher-facing per-student profile route
 * (routes/backoffice/organization.ts) so both surfaces stay in sync.
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { computeStudentMasterySummary } from "../../services/mastery/masterySummary";

export const masteryRouter = Router();

masteryRouter.get("/api/student/mastery", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? "";
    if (!identifier) return res.status(400).json({ message: "Identifiant requis" });

    const summary = await computeStudentMasterySummary(identifier);
    if (!summary) return res.status(500).json({ message: "Graphe des compétences indisponible" });

    return res.status(200).json({
      graphApplied: summary.graphApplied,
      attempts: summary.attempts,
      revise: summary.revise
    });
  } catch (error) {
    console.error("Failed to build student mastery:", error);
    return res.status(500).json({ message: "Impossible de calculer la maîtrise pour le moment" });
  }
});
