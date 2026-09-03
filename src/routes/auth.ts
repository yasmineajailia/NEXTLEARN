import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { User } from "../models/User";
import { StudentProfile } from "../models/StudentProfile";
import { Teacher } from "../models/Teacher";
import { env } from "../config/env";
import { comparePassword } from "../utils/password";
import { issueSession, clearSession } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";

// Brute-force guard for login, keyed by IP+email so a shared campus IP does not
// lock out different accounts, while attempts against one account are capped.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyFn: (req) => `${req.ip || "?"}:${String(req.body?.email || "").toLowerCase()}`,
  message: "Trop de tentatives de connexion. Réessayez dans quelques minutes."
});

// Flood guard for the email-sending / token endpoints, keyed by IP.
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Trop de demandes. Réessayez plus tard."
});

const authRouter = Router();
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60;

function normalizeRole(value: string): "étudiant" | "enseignant" | "admin" | "unknown" {
  const role = String(value || "").trim().toLowerCase();

  if (role === "student" || role === "étudiant" || role === "etudiant") {
    return "étudiant";
  }

  if (role === "teacher" || role === "enseignant") {
    return "enseignant";
  }

  if (role === "admin") {
    return "admin";
  }

  return "unknown";
}

let mailerPromise: Promise<Transporter> | null = null;

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isStrongPassword(value: string): boolean {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(String(value || ""));
}

function hasSmtpConfiguration(): boolean {
  return Boolean(env.smtpHost && env.smtpUser && env.smtpPass && env.smtpFrom);
}

async function getMailer(): Promise<Transporter> {
  if (!hasSmtpConfiguration()) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, and SMTP_FROM."
    );
  }

  if (mailerPromise) {
    return mailerPromise;
  }

  mailerPromise = (async () => {
    return nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass
      }
    });
  })();

  return mailerPromise;
}

function buildResetLink(token: string): string {
  const base = env.appBaseUrl.replace(/\/$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

async function sendResetPasswordEmail(targetEmail: string, fullName: string, token: string): Promise<void> {
  const transporter = await getMailer();
  const resetLink = buildResetLink(token);

  const info = await transporter.sendMail({
    from: env.smtpFrom,
    to: targetEmail,
    subject: "NextLearn - Réinitialisation de mot de passe",
    text: `Bonjour ${fullName},\n\nCliquez sur ce lien pour réinitialiser votre mot de passe:\n${resetLink}\n\nCe lien expire dans 1 heure.\n`,
    html: `<p>Bonjour ${fullName},</p><p>Cliquez sur ce lien pour réinitialiser votre mot de passe:</p><p><a href=\"${resetLink}\">Réinitialiser mon mot de passe</a></p><p>Ce lien expire dans 1 heure.</p>`
  });

  console.log("Password reset email sent:", info.messageId);
}

// Public sign-up is intentionally disabled. Accounts are created by admins only.
authRouter.post("/api/sign-up", async (_req: Request, res: Response) => {
  res.status(403).json({ error: "Inscription désactivée. Contactez un administrateur." });
});

// Sign-in endpoint
authRouter.post("/api/sign-in", loginLimiter, async (req: Request, res: Response) => {
  try {
    const requestedRole = typeof req.body?.role === "string" ? normalizeRole(req.body.role) : "unknown";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Format d'email invalide" });
    }

    let accountInfo: { type: "teacher"; account: any } | { type: "student"; account: any } | null = null;

    if (requestedRole === "enseignant" || requestedRole === "admin") {
      const teacher = await Teacher.findOne({ email });
      if (teacher) accountInfo = { type: "teacher", account: teacher };
    } else if (requestedRole === "étudiant") {
      const user = await User.findOne({ email });
      if (user) accountInfo = { type: "student", account: user };
    } else {
      // requestedRole === "unknown" fallback
      const teacher = await Teacher.findOne({ email });
      if (teacher) {
        accountInfo = { type: "teacher", account: teacher };
      } else {
        const user = await User.findOne({ email });
        if (user) accountInfo = { type: "student", account: user };
      }
    }

    if (!accountInfo) {
      return res.status(401).json({ error: "Email ou mot de passe incorrect" });
    }

    if (accountInfo.type === "teacher") {
      const teacher = accountInfo.account;
      const isPasswordValid = await comparePassword(password, teacher.password);
      if (!isPasswordValid) {
        return res.status(401).json({ error: "Email ou mot de passe incorrect" });
      }

      const teacherRole = normalizeRole(teacher.role) === "admin" ? "admin" : "enseignant";

      // Enforce admin strictness if explicitly requested
      if (requestedRole === "admin" && teacherRole !== "admin") {
        return res.status(403).json({ error: "Ce compte n'est pas administrateur. Utilisez l'onglet Enseignant." });
      }

      issueSession(res, { id: String(teacher._id), role: teacherRole });
      return res.status(200).json({
        message: "Connexion réussie",
        user: {
          id: teacher._id,
          role: teacherRole,
          fullName: teacher.name,
          email: teacher.email,
          phone: teacher.phone
        }
      });
    } else {
      const user = accountInfo.account;
      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({ error: "Email ou mot de passe incorrect" });
      }

      // Track login metrics async
      void StudentProfile.findOneAndUpdate(
        { identifier: user.identifier },
        { $inc: { loginCount: 1 }, $set: { lastLoginDate: new Date() } }
      ).catch(() => {});

      issueSession(res, { id: user.identifier, role: "student" });
      return res.status(200).json({
        message: "Connexion réussie",
        user: {
          id: user._id,
          role: "étudiant",
          fullName: user.fullName || user.identifier,
          identifier: user.identifier,
          email: user.email,
          varkCompleted: Boolean(user.varkProfile?.completedAt)
        }
      });
    }
  } catch (error) {
    console.error("Sign-in error:", error);
    res.status(500).json({ error: "Erreur lors de la connexion" });
  }
});

// Clears the session cookie. The client should also drop its local display state.
authRouter.post("/api/logout", (_req: Request, res: Response) => {
  clearSession(res);
  res.status(200).json({ message: "Déconnexion réussie" });
});

authRouter.post("/api/forgot-password", emailLimiter, async (req: Request, res: Response) => {
  try {
    if (!hasSmtpConfiguration()) {
      return res.status(503).json({
        error:
          "Service email non configuré. Contactez l'administrateur pour définir SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS et SMTP_FROM."
      });
    }

    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Email invalide" });
    }

    const user = await User.findOne({ email });

    if (user) {
      const resetToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");

      user.passwordResetTokenHash = tokenHash;
      user.passwordResetExpiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
      await user.save();

      await sendResetPasswordEmail(user.email, user.fullName, resetToken);
    }

    res.status(200).json({
      message: "Un lien de réinitialisation vient d'être envoyé."
    });
  } catch (error) {
    console.error("Forgot-password error:", error);
    res.status(500).json({ error: "Erreur lors de la demande de réinitialisation" });
  }
});

authRouter.post("/api/reset-password", loginLimiter, async (req: Request, res: Response) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const newPassword = typeof req.body?.password === "string" ? req.body.password : "";

    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token et mot de passe requis" });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        error:
          "Mot de passe invalide. Utilisez au moins 8 caractères avec majuscule, minuscule, chiffre et symbole"
      });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ error: "Lien de réinitialisation invalide ou expiré" });
    }

    user.password = newPassword;
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    res.status(200).json({ message: "Mot de passe réinitialisé avec succès" });
  } catch (error) {
    console.error("Reset-password error:", error);
    res.status(500).json({ error: "Erreur lors de la réinitialisation du mot de passe" });
  }
});

export { authRouter };
