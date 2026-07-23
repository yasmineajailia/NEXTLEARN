/**
 * auth.ts (middleware)
 *
 * Server-verified sessions via JWT stored in an HTTP-only cookie.
 *
 * Replaces the old trust-the-client model, where identity came from a
 * client-set `X-Teacher-Id` header or an `identifier` in the request body —
 * both trivially forgeable. Now:
 *
 *   - `issueSession` signs a JWT (id + role) on successful login and sets it as
 *     an HttpOnly, SameSite=Lax, Secure-in-prod cookie the browser cannot read
 *     from JavaScript (immune to XSS token theft) and sends automatically on
 *     every same-origin request.
 *   - `requireAuth` / `requireRole` verify that cookie and attach the trusted
 *     identity to `req.auth`. Endpoints read identity from there, never from
 *     client-supplied fields.
 */
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export type AuthRole = "admin" | "enseignant" | "student";
export type AuthClaims = { id: string; role: AuthRole };

const COOKIE_NAME = "nl_session";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_TTL = "7d";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Verified identity from the session cookie, set by requireAuth/requireRole. */
      auth?: AuthClaims;
    }
  }
}

/** Signs a session JWT and sets it as the session cookie. Call on login. */
export function issueSession(res: Response, claims: AuthClaims): void {
  const token = jwt.sign({ sub: claims.id, role: claims.role }, env.authSecret, { expiresIn: TOKEN_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
    path: "/"
  });
}

/** Clears the session cookie. Call on logout. */
export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

/** Reads the raw session token from the Cookie header (no cookie-parser needed). */
function readTokenFromCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === COOKIE_NAME) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Renew the cookie once it drops below this much remaining life (sliding session). */
const REFRESH_WHEN_UNDER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

type VerifiedToken = AuthClaims & { exp?: number };

/** Verifies the session cookie, returning claims (+ expiry) or null when absent/invalid. */
function verifyToken(req: Request): VerifiedToken | null {
  const token = readTokenFromCookie(req);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.authSecret) as { sub?: unknown; role?: unknown; exp?: number };
    const id = typeof payload.sub === "string" ? payload.sub : "";
    const role = payload.role;
    if (!id || (role !== "admin" && role !== "enseignant" && role !== "student")) return null;
    return { id, role, exp: typeof payload.exp === "number" ? payload.exp : undefined };
  } catch {
    return null; // expired or tampered
  }
}

/** Verifies the session cookie and returns the claims, or null when absent/invalid. */
export function getAuth(req: Request): AuthClaims | null {
  const v = verifyToken(req);
  return v ? { id: v.id, role: v.role } : null;
}

/** Sliding session: reissue the cookie when it is close to expiry so active users stay logged in. */
function maybeRefresh(res: Response, v: VerifiedToken): void {
  if (!v.exp) return;
  const msLeft = v.exp * 1000 - Date.now();
  if (msLeft > 0 && msLeft < REFRESH_WHEN_UNDER_MS) {
    issueSession(res, { id: v.id, role: v.role });
  }
}

/** Rejects the request with 401 unless a valid session cookie is present. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const v = verifyToken(req);
  if (!v) {
    res.status(401).json({ error: "Authentification requise" });
    return;
  }
  req.auth = { id: v.id, role: v.role };
  maybeRefresh(res, v);
  next();
}

/** Rejects with 401 (no session) or 403 (wrong role) unless the caller holds one of `roles`. */
export function requireRole(...roles: AuthRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const v = verifyToken(req);
    if (!v) {
      res.status(401).json({ error: "Authentification requise" });
      return;
    }
    if (!roles.includes(v.role)) {
      res.status(403).json({ error: "Accès refusé" });
      return;
    }
    req.auth = { id: v.id, role: v.role };
    maybeRefresh(res, v);
    next();
  };
}
