/**
 * Tests for the in-memory rate limiter used on auth, chatbot, and
 * quiz-generation endpoints — the thing standing between a scripted student
 * and an unbounded bill on a paid LLM API.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { rateLimit } from "./rateLimit";

function makeReq(overrides: Partial<Request> = {}): Request {
  return { ip: "1.2.3.4", socket: { remoteAddress: "1.2.3.4" } as any, ...overrides } as Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
      return res as Response;
    }),
    status: vi.fn(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn(function (this: any, body: unknown) {
      this.body = body;
      return this;
    })
  };
  (res as any).headers = headers;
  return res as Response & { statusCode?: number; body?: unknown; headers: Record<string, string> };
}

describe("rateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    const req = makeReq();
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      const next = vi.fn();
      limiter(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it("blocks the request once the limit is exceeded, with a 429 and Retry-After", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 2, message: "slow down" });
    const req = makeReq();

    for (let i = 0; i < 2; i++) {
      limiter(req, makeRes(), vi.fn());
    }

    const res = makeRes();
    const next = vi.fn();
    limiter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect((res as any).body).toEqual({ error: "slow down" });
    expect((res as any).headers["Retry-After"]).toBeDefined();
  });

  it("tracks separate keys independently so one student can't exhaust another's budget", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1, keyFn: (req) => (req as any).userId });
    const alice = makeReq({ } as any);
    (alice as any).userId = "alice";
    const bob = makeReq({} as any);
    (bob as any).userId = "bob";

    limiter(alice, makeRes(), vi.fn());
    const aliceSecondNext = vi.fn();
    limiter(alice, makeRes(), aliceSecondNext);
    expect(aliceSecondNext).not.toHaveBeenCalled(); // alice is now over her limit

    const bobNext = vi.fn();
    limiter(bob, makeRes(), bobNext);
    expect(bobNext).toHaveBeenCalledOnce(); // bob's own bucket is untouched
  });

  it("resets the count once the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = rateLimit({ windowMs: 1000, max: 1 });
    const req = makeReq();

    limiter(req, makeRes(), vi.fn());
    const blockedNext = vi.fn();
    limiter(req, makeRes(), blockedNext);
    expect(blockedNext).not.toHaveBeenCalled();

    vi.setSystemTime(1001); // past the window
    const allowedNext = vi.fn();
    limiter(req, makeRes(), allowedNext);
    expect(allowedNext).toHaveBeenCalledOnce();
  });

  it("falls back to req.ip, then socket.remoteAddress, when no keyFn is given", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    const reqA = makeReq({ ip: "9.9.9.9" } as any);
    const reqB = makeReq({ ip: "8.8.8.8" } as any);

    limiter(reqA, makeRes(), vi.fn());
    const reqBNext = vi.fn();
    limiter(reqB, makeRes(), reqBNext);
    expect(reqBNext).toHaveBeenCalledOnce(); // different IP, independent bucket
  });
});
