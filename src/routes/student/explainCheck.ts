/**
 * "Explain it in your own words" route (NLP semantic gap analysis).
 *
 * The student writes a free-text explanation of the lesson they are viewing;
 * the Python ML service compares it against the lesson's OWN indexed content
 * and returns which key concepts are covered vs missing. The result is shown
 * immediately as formative feedback AND persisted as a text-derived weak
 * signal (progress.textSignals) that the learner profile / recommendations
 * can consume — a struggle the MCQ quizzes may never surface.
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { User } from "../../models/User";
import { fetchAnswerGap } from "../../services/nlp/answerGapClient";

export const explainCheckRouter = Router();

const MIN_TEXT_CHARS = 20;
const MAX_TEXT_CHARS = 3000;
const MAX_STORED_SIGNALS = 50;
const MAX_STORED_CONCEPTS = 3;

explainCheckRouter.post("/api/student/explain-check", requireAuth, async (req, res) => {
  try {
    const identifier = req.auth?.id ?? ""; // verified session identity
    if (!identifier) return res.status(400).json({ message: "Identifiant requis" });

    const moduleId = typeof req.body?.moduleId === "string" ? req.body.moduleId.trim() : "";
    const subAcquisId = typeof req.body?.subAcquisId === "string" ? req.body.subAcquisId.trim() : "";
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const lang: "fr" | "en" = req.body?.lang === "en" ? "en" : "fr";

    if (!moduleId || !subAcquisId) {
      return res.status(400).json({ message: "Leçon requise" });
    }
    if (text.length < MIN_TEXT_CHARS || text.length > MAX_TEXT_CHARS) {
      return res.status(400).json({
        message: `Explication entre ${MIN_TEXT_CHARS} et ${MAX_TEXT_CHARS} caractères requise`
      });
    }

    const result = await fetchAnswerGap({ moduleId, subAcquisId, text, lang });

    // Persist only real analyses — a too-short/no-content miss is not a signal.
    if (result.available && typeof result.score === "number" && result.band) {
      await User.updateOne(
        { identifier },
        {
          $push: {
            "progress.textSignals": {
              $each: [
                {
                  moduleId,
                  subAcquisId,
                  score: result.score,
                  band: result.band,
                  missingConcepts: (result.missing ?? []).slice(0, MAX_STORED_CONCEPTS),
                  submittedAt: new Date()
                }
              ],
              $slice: -MAX_STORED_SIGNALS
            }
          }
        }
      );
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("Failed to run explain-check:", error);
    return res.status(500).json({ message: "Impossible d'analyser votre explication pour le moment" });
  }
});
