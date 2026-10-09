/** Environment-driven configuration. Credentials have no defaults: a missing
 * one stops the process at startup with the variable's name (see .env.example). */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `[config] ${name} is not set. Copy .env.example to .env and fill it in ` +
        `(or set the variable on the service), then start again.`,
    );
    process.exit(1);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`[config] ${name} must be a number, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

/** Behind Railway's edge proxy the client address arrives in X-Forwarded-For;
 * anywhere else that header is attacker-controlled and must be ignored. Railway
 * injects these two ids into every running service; a developer's RAILWAY_TOKEN
 * for the CLI must not count, so the check is deliberately this narrow. */
const behindRailway = Boolean(process.env.RAILWAY_SERVICE_ID || process.env.RAILWAY_ENVIRONMENT_ID);

export const config = {
  queueflowUrl: process.env.QUEUEFLOW_URL ?? "http://localhost:8000",
  /** Tenant credential (one of the engine's `--api-keys KEY:TENANT` keys). */
  token: requireEnv("QUEUEFLOW_TOKEN"),
  /** Worker credential (the engine's `--worker-token`). */
  workerToken: requireEnv("QUEUEFLOW_WORKER_TOKEN"),
  /**
   * Bearer token for mutating dispatch-office calls (DLQ replay, cron
   * pause/resume). Optional: when unset those calls answer 503 and the
   * read-only admin views keep working.
   */
  adminToken: process.env.SHIPIT_ADMIN_TOKEN || null,
  port: optionalNumber("PORT", 3100),
  /**
   * Ambient chaos: probability that any single payment attempt fails.
   * Bubble Wrap orders ignore this and fail deterministically (see worker.ts).
   */
  paymentFailureRate: optionalNumber("PAYMENT_FAILURE_RATE", 0.25),
  /** Honour X-Forwarded-For (one hop) for rate limiting. */
  trustProxy: behindRailway || process.env.TRUST_PROXY === "1",
  /** Per-IP budget for public mutating routes, per 60s window. */
  rateLimitPerMinute: optionalNumber("RATE_LIMIT_PER_MINUTE", 20),
} as const;

/**
 * The engine schedules workflow-step jobs on its default queue, so the Node
 * worker leases from it. The server is started with `--default-queue orders`.
 */
export const ORDERS_QUEUE = "orders";

/** Hand-off queue consumed by the Python warehouse worker (worker-py/). */
export const WAREHOUSE_QUEUE = "warehouse";
