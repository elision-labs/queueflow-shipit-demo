/**
 * Ship-It's web process: the storefront + dispatch-office API. A thin
 * QueueFlow client — every durable decision (retries, policies, DLQ,
 * scheduling) lives server-side in the engine.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { ApiError, ConflictError, ConnectionError, TimeoutError, type Job } from "@queueflow/sdk";
import { qf } from "./queueflow.js";
import { config, ORDERS_QUEUE } from "./config.js";
import { rateLimit, requireAdmin } from "./guards.js";
import { CATALOG, TASKS, newOrderId, orderWorkflow, type Order } from "./pipeline.js";

const app = express();
// Behind Railway's proxy the client address is the first X-Forwarded-For hop;
// elsewhere the header is untrusted and req.ip is the socket address.
if (config.trustProxy) app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public")));

// Abuse protection: every mutating /api call (orders, admin actions) shares
// one per-IP budget; GETs and the SSE tracker are not counted.
app.use("/api", rateLimit(config.rateLimitPerMinute));
// Dispatch-office mutations need the operator's bearer token; reads stay open.
app.use("/api/admin", requireAdmin);

// ---- Storefront --------------------------------------------------------------

app.get("/api/catalog", (_req, res) => {
  res.json({ products: CATALOG });
});

app.post("/api/orders", async (req, res, next) => {
  try {
    const { sku, qty, email, bounceEmail } = req.body as {
      sku?: string;
      qty?: number;
      email?: string;
      bounceEmail?: boolean;
    };
    const product = CATALOG.find((p) => p.sku === sku);
    if (!product) return res.status(400).json({ error: `unknown product "${sku}"` });
    if (!email) return res.status(400).json({ error: "email is required" });

    const order: Order = {
      id: newOrderId(),
      sku: product.sku,
      name: product.name,
      qty: Math.max(1, Math.floor(qty ?? 1)),
      email,
      totalCents: product.priceCents * Math.max(1, Math.floor(qty ?? 1)),
      flakyPayment: product.sku === "BUBBLE-1KM",
      bounceEmail: Boolean(bounceEmail),
    };
    const workflow = await qf.workflows.create(orderWorkflow(order));
    res.status(201).json({ orderId: order.id, workflowId: workflow.id });
  } catch (err) {
    next(err);
  }
});

/** One consistent snapshot of an order: workflow + live step states + the
 * jobs behind interesting steps + the warehouse hand-off job. */
async function orderSnapshot(workflowId: string) {
  const [workflow, steps] = await Promise.all([
    qf.workflows.get(workflowId),
    qf.workflows.steps(workflowId),
  ]);
  const jobs = new Map<string, Job>();
  await Promise.all(
    steps
      .filter((s) => s.job_id)
      .map(async (s) => {
        try {
          jobs.set(s.name, await qf.jobs.get(s.job_id as string));
        } catch {
          /* purged by retention; the step status still tells the story */
        }
      }),
  );

  const context = (workflow.context ?? {}) as Record<string, unknown>;
  const order = context.order as Order | undefined;

  // The warehouse step's result carries the Python-side pack job's id.
  const warehouseResult = context.warehouse as { pack_job_id?: string } | undefined;
  let packJob: Job | null = null;
  if (warehouseResult?.pack_job_id) {
    try {
      packJob = await qf.jobs.get(warehouseResult.pack_job_id);
    } catch {
      packJob = null;
    }
  }

  return {
    order: order ?? null,
    workflow: {
      id: workflow.id,
      status: workflow.status,
      createdAt: workflow.created_at,
      completedAt: workflow.completed_at ?? null,
    },
    steps: steps.map((s) => {
      const job = jobs.get(s.name);
      return {
        name: s.name,
        status: s.status,
        job: job
          ? {
              status: job.status,
              retryCount: job.retry_count,
              deliveryCount: job.delivery_count,
              nextRetryAt: job.next_retry_at ?? null,
              error: job.error_message ?? null,
              result: job.result ?? null,
            }
          : null,
      };
    }),
    warehouse: packJob
      ? {
          jobId: packJob.id,
          status: packJob.status,
          result: packJob.result ?? null,
          error: packJob.error_message ?? null,
        }
      : null,
  };
}

app.get("/api/orders/:workflowId", async (req, res, next) => {
  try {
    res.json(await orderSnapshot(req.params.workflowId));
  } catch (err) {
    next(err);
  }
});

/** Live tracker feed: SSE to the browser. The web process polls the engine
 * (workflow + step states + the jobs behind them) and pushes a snapshot
 * whenever anything changed; ends once the workflow AND the warehouse
 * hand-off are settled. */
app.get("/api/orders/:workflowId/events", async (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let last = "";
  let closed = false;
  let settledPolls = 0;
  req.on("close", () => (closed = true));
  const deadline = Date.now() + 3 * 60_000;

  while (!closed && Date.now() < deadline) {
    try {
      const snapshot = await orderSnapshot(req.params.workflowId);
      const serialized = JSON.stringify(snapshot);
      if (serialized !== last) {
        last = serialized;
        send("snapshot", snapshot);
      }
      const workflowSettled = ["completed", "failed", "partially_failed", "cancelled"].includes(
        snapshot.workflow.status,
      );
      const warehouseSettled =
        snapshot.warehouse === null ||
        ["completed", "failed", "cancelled"].includes(snapshot.warehouse.status);
      // Everything terminal: allow a couple of grace polls so late writes
      // (the warehouse step's result landing in context) still stream out.
      if (workflowSettled && warehouseSettled) {
        const handoffPending =
          snapshot.workflow.status === "completed" && snapshot.warehouse === null;
        if (!handoffPending || settledPolls >= 3) break;
        settledPolls += 1;
      }
    } catch (err) {
      send("error", { error: err instanceof Error ? err.message : String(err) });
      break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  send("done", {});
  res.end();
});

// ---- Dispatch office (admin) ---------------------------------------------------

app.get("/api/admin/jobs", async (req, res, next) => {
  try {
    const page = await qf.jobs.list({
      limit: 15,
      status: (req.query.status as string) || undefined,
      queue: (req.query.queue as string) || undefined,
      cursor: (req.query.cursor as string) || undefined,
      createdAfter: (req.query.createdAfter as string) || undefined,
      createdBefore: (req.query.createdBefore as string) || undefined,
    });
    res.json({
      jobs: page.jobs.map((j) => ({
        id: j.id,
        task: j.task_name,
        queue: j.queue_name,
        status: j.status,
        retries: j.retry_count,
        deliveries: j.delivery_count,
        createdAt: j.created_at,
        error: j.error_message ?? null,
      })),
      nextCursor: page.next_cursor ?? null,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/admin/dlq", async (_req, res, next) => {
  try {
    const page = await qf.dlq.list({ limit: 25 });
    res.json({
      deadLetters: page.dead_letters.map((d) => ({
        id: d.id,
        jobId: d.job_id,
        task: d.task_name ?? null,
        queue: d.queue_name ?? null,
        reason: d.reason,
        error: d.error_message ?? null,
        createdAt: d.created_at,
        replayedAs: d.replay_job_id ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/dlq/:id/replay", async (req, res, next) => {
  try {
    const jobId = await qf.dlq.replay(Number(req.params.id));
    res.status(201).json({ jobId });
  } catch (err) {
    next(err);
  }
});

app.get("/api/admin/crons", async (_req, res, next) => {
  try {
    const page = await qf.cron.list({ limit: 25 });
    res.json({
      crons: page.crons.map((c) => ({
        id: c.id,
        name: c.name,
        schedule: c.cron_expr,
        task: c.task_name,
        enabled: c.enabled,
        nextRunAt: c.next_run_at,
        lastEnqueuedAt: c.last_enqueued_at ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/crons/:id/:action", async (req, res, next) => {
  try {
    const { id, action } = req.params;
    if (action === "pause") await qf.cron.pause(id);
    else if (action === "resume") await qf.cron.resume(id);
    else return res.status(400).json({ error: `unknown action "${action}"` });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get("/api/admin/stats", async (_req, res, next) => {
  try {
    res.json(await qf.system.stats());
  } catch (err) {
    next(err);
  }
});

// ---- Error mapping ---------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ConnectionError || err instanceof TimeoutError) {
    // The engine is down or unreachable - say so, instead of a generic 500
    // the dispatch office can only render as "internal error".
    return res.status(502).json({ error: `queueflow engine unreachable: ${err.message}` });
  }
  console.error("[web] unhandled:", err);
  res.status(500).json({ error: "internal error" });
});

/** Register the standing cron route; a 409 means it already exists. Never
 * fatal: the storefront must come up even when the engine is still booting
 * (or down) — registration retries in the background until it lands. */
async function ensureCron(): Promise<void> {
  for (;;) {
    try {
      await qf.cron.create({
        name: "abandoned-cart-sweep",
        schedule: "* * * * *",
        task: TASKS.cartSweep,
        queue: ORDERS_QUEUE,
      });
      console.log("[web] registered cron: abandoned-cart-sweep (every minute)");
      return;
    } catch (err) {
      if (err instanceof ConflictError) return; // already registered
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[web] cron registration failed (${msg}); retrying in 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

export async function startWeb(): Promise<void> {
  void ensureCron();
  await new Promise<void>((resolve) => app.listen(config.port, resolve));
  console.log(`[web] Ship-It storefront:   http://localhost:${config.port}`);
  console.log(`[web] Dispatch office:      http://localhost:${config.port}/admin.html`);
  console.log(
    `[web] rate limit: ${config.rateLimitPerMinute}/min per IP on mutating /api routes` +
      (config.trustProxy ? " (trusting one proxy hop)" : ""),
  );
  if (!config.adminToken) {
    console.warn(
      "[web] SHIPIT_ADMIN_TOKEN is not set: DLQ replay and cron pause/resume answer 503 until it is",
    );
  }
}
