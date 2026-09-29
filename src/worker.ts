/**
 * The Node worker: leases order-pipeline steps from the `orders` queue over
 * the remote worker protocol (lease → heartbeat → complete/fail). The engine
 * owns retries, backoff, the dead-letter queue, and workflow advancement —
 * this process only executes handlers and reports outcomes.
 *
 * Delivery is at-least-once, so every handler here is idempotent: the one
 * with a side effect that must not double (the review-request enqueue) is
 * guarded by an idempotency key.
 */

import { NonRetryableError, type Job, type JsonObject } from "@queueflow/sdk";
import { config, ORDERS_QUEUE, WAREHOUSE_QUEUE } from "./config.js";
import { qf } from "./queueflow.js";
import { TASKS, type Order } from "./pipeline.js";

/** Steps read the order (and upstream results) from the workflow context. */
function ctx(job: Job): { order: Order; [step: string]: unknown } {
  const c = (job.payload as { _context?: JsonObject } | undefined)?._context;
  if (!c || typeof c !== "object" || !("order" in c)) {
    throw new NonRetryableError(`job ${job.id} has no order in its context`);
  }
  return c as { order: Order; [step: string]: unknown };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const handlers: Record<string, (job: Job) => Promise<JsonObject>> = {
  [TASKS.validate]: async (job) => {
    const { order } = ctx(job);
    await delay(300);
    if (!order.email.includes("@")) {
      throw new NonRetryableError(`"${order.email}" is not a deliverable address`);
    }
    if (order.qty < 1) throw new NonRetryableError("quantity must be at least 1");
    console.log(`[orders] ${order.id} validated (${order.qty} x ${order.sku})`);
    return { valid: true };
  },

  [TASKS.charge]: async (job) => {
    const { order } = ctx(job);
    await delay(400);
    // Bubble Wrap: fail the first three attempts DETERMINISTICALLY so the
    // retry storm (exponential backoff + jitter) is watchable and always
    // ends the same way. Everything else fails at the ambient chaos rate.
    const flakyStillFailing = order.flakyPayment && job.retry_count < 3;
    const ambientFailure = !order.flakyPayment && Math.random() < config.paymentFailureRate;
    if (flakyStillFailing || ambientFailure) {
      console.log(
        `[orders] ${order.id} payment attempt ${job.retry_count + 1} declined (gateway wobble)`,
      );
      throw new Error("payment gateway returned 503 (simulated)"); // retryable
    }
    const transactionId = "TXN-" + Math.random().toString(36).slice(2, 10).toUpperCase();
    console.log(`[orders] ${order.id} charged ${order.totalCents} cents (${transactionId})`);
    return { transaction_id: transactionId, amount_cents: order.totalCents };
  },

  [TASKS.fraud]: async (job) => {
    const { order } = ctx(job);
    await delay(350);
    if (order.totalCents > 500_000) {
      // Permanent failure: skips retries, dead-letters the job, and — via the
      // step's `halt` policy — fails the whole workflow.
      throw new NonRetryableError(
        `order value ${(order.totalCents / 100).toFixed(2)} exceeds the single-shipment fraud limit`,
      );
    }
    return { risk: "low" };
  },

  [TASKS.reserve]: async (job) => {
    const { order } = ctx(job);
    await delay(250);
    console.log(`[orders] ${order.id} reserved ${order.qty} x ${order.sku}`);
    return { reserved: order.qty, sku: order.sku };
  },

  [TASKS.invoice]: async (job) => {
    const c = ctx(job);
    await delay(250);
    // Upstream results are keyed by STEP NAME (not task name) in the
    // propagated context: the "charge" step's result carries the txn id.
    const txn = (c.charge as { transaction_id?: string } | undefined)?.transaction_id;
    const invoiceNo = "INV-" + c.order.id.slice(4);
    console.log(`[orders] ${c.order.id} invoiced as ${invoiceNo} (payment ${txn ?? "n/a"})`);
    return { invoice_no: invoiceNo, transaction_id: txn ?? null };
  },

  [TASKS.confirm]: async (job) => {
    const { order } = ctx(job);
    await delay(300);
    if (order.bounceEmail) {
      // Retryable, but max_retries is 1: two bounces and the job
      // dead-letters while the step's `skip` policy lets the order proceed.
      throw new Error(`mailbox unavailable for ${order.email} (simulated bounce)`);
    }
    console.log(`[orders] ${order.id} confirmation sent to ${order.email}`);
    return { sent_to: order.email };
  },

  [TASKS.warehouse]: async (job) => {
    const { order } = ctx(job);
    // Hand off to the Python worker on its own queue. This handler can run
    // twice (at-least-once), so the review-request enqueue is idempotent;
    // the pack job tolerates a rare duplicate (packing is idempotent too).
    const packJobId = await qf.jobs.enqueue({
      task: TASKS.pack,
      queue: WAREHOUSE_QUEUE,
      payload: { order: { ...order } },
    });
    const reviewJobId = await qf.jobs.enqueue({
      task: TASKS.review,
      payload: { order_id: order.id, email: order.email },
      runAt: new Date(Date.now() + 90_000), // "7 days later", demo-compressed
      idempotencyKey: `review:${order.id}`,
    });
    console.log(`[orders] ${order.id} handed to warehouse (pack job ${packJobId})`);
    return { pack_job_id: packJobId, review_job_id: reviewJobId };
  },

  [TASKS.review]: async (job) => {
    const { order_id, email } = job.payload as { order_id?: string; email?: string };
    console.log(`[orders] review request for ${order_id} sent to ${email}`);
    return { sent: true };
  },

  [TASKS.cartSweep]: async () => {
    console.log("[orders] cron: swept abandoned carts");
    return { swept: 0 };
  },
};

/** Run the lease/heartbeat/report loop until `signal` aborts. */
export function startWorker(signal: AbortSignal): Promise<void> {
  console.log(
    `[worker] leasing "${ORDERS_QUEUE}" (tasks: ${Object.keys(handlers).join(", ")})`,
  );
  return qf.worker.run(ORDERS_QUEUE, handlers, { leaseSecs: 30, waitSecs: 20, signal });
}
