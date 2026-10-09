/** Request guards for the web process: admin bearer auth and a small
 * in-memory per-IP rate limiter. No external dependencies on purpose. */

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mutating /api/admin calls need `Authorization: Bearer <SHIPIT_ADMIN_TOKEN>`.
 * Reads pass through so the dispatch office stays browsable. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (READ_METHODS.has(req.method)) return next();
  if (!config.adminToken) {
    res.status(503).json({
      error:
        "admin actions are disabled: the operator must set SHIPIT_ADMIN_TOKEN on the web service",
    });
    return;
  }
  const header = req.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!presented || !tokenMatches(presented, config.adminToken)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="shipit-admin"');
    res.status(401).json({ error: "admin token missing or invalid" });
    return;
  }
  next();
}

/** Fixed-window limiter keyed by client IP. `req.ip` honours X-Forwarded-For
 * only when `trust proxy` is set (see server.ts). Reads are never limited. */
export function rateLimit(limit: number, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
  }, windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (READ_METHODS.has(req.method)) return next();
    const now = Date.now();
    const ip = req.ip ?? "unknown";
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - entry.count)));
    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: `too many requests from this address; try again in ${retryAfter}s`,
      });
      return;
    }
    next();
  };
}
