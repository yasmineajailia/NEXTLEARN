/**
 * rateLimit.ts (middleware)
 *
 * Minimal in-memory fixed-window rate limiter — no dependency. Protects the
 * auth endpoints from brute-force / flooding. Suitable for a single-instance
 * deployment; for multiple instances the store would move to Redis.
 *
 * NOTE on client IP: `req.ip` is only accurate behind a proxy when Express is
 * told to trust it (`app.set("trust proxy", ...)`). For direct/local serving it
 * is correct as-is.
 */
import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  message?: string;
  /** Derive the bucket key; defaults to the client IP. */
  keyFn?: (req: Request) => string;
}) {
  const { windowMs, max, message = "Trop de tentatives. Réessayez plus tard.", keyFn } = opts;
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = (keyFn ? keyFn(req) : req.ip || req.socket.remoteAddress || "unknown") || "unknown";

    // Opportunistic prune so the map can't grow unbounded over a long uptime.
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    }

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (bucket.count >= max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: message });
      return;
    }
    bucket.count++;
    next();
  };
}
