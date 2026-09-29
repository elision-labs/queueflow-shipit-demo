/**
 * The order pipeline: catalog, task names, and the workflow DAG.
 *
 *                    ┌─ charge_payment ─┐
 *   validate_order ──┤                  ├─ reserve_inventory ─ generate_invoice ─┬─ send_confirmation (skip on failure)
 *                    └─ fraud_check ────┘                                        └─ notify_warehouse ─→ pack_order (Python, "warehouse" queue)
 *
 * Failure policies are per-step: a fraud rejection HALTS the workflow (and
 * dead-letters the job); a bounced confirmation email is SKIPPED so the order
 * still ships (workflow ends `partially_failed`).
 */

import { wf, type WorkflowBuilder } from "@queueflow/sdk";

export const TASKS = {
  validate: "validate_order",
  charge: "charge_payment",
  fraud: "fraud_check",
  reserve: "reserve_inventory",
  invoice: "generate_invoice",
  confirm: "send_confirmation",
  warehouse: "notify_warehouse",
  /** Runs on the `warehouse` queue, handled by the Python worker. */
  pack: "pack_order",
  /** Scheduled 90s after purchase via `runAt` (a stand-in for "7 days"). */
  review: "review_request",
  /** Fired every minute by the `abandoned-cart-sweep` cron schedule. */
  cartSweep: "cart_sweep",
} as const;

export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  /** What ordering this product demonstrates, shown on the label card. */
  demonstrates: string;
}

/** Each product is a scripted scenario. */
export const CATALOG: Product[] = [
  {
    sku: "ANVIL-40",
    name: "Anvil, 40 lb",
    priceCents: 12_900,
    demonstrates: "the happy path (with ambient payment chaos)",
  },
  {
    sku: "BUBBLE-1KM",
    name: "Bubble wrap, 1 km roll",
    priceCents: 4_900,
    demonstrates: "a retry storm: payment fails 3 times, backs off, then clears",
  },
  {
    sku: "CASE-9999",
    name: "Suspicious briefcase",
    priceCents: 999_900,
    demonstrates: "a fraud halt: non-retryable failure, dead letter, replay",
  },
];

export interface Order {
  id: string;
  sku: string;
  name: string;
  qty: number;
  email: string;
  totalCents: number;
  /** BUBBLE-1KM sets this: fail the first 3 payment attempts, then succeed. */
  flakyPayment: boolean;
  /** Storefront checkbox: the confirmation email bounces (skip policy). */
  bounceEmail: boolean;
}

export function newOrderId(): string {
  return "SHP-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** Build the order workflow. The order rides in the shared context, so every
 * step reads it from `payload._context.order` and downstream steps also see
 * upstream results there (e.g. the invoice step reads the payment's
 * transaction id from `_context.charge_payment`). */
export function orderWorkflow(order: Order): WorkflowBuilder {
  return wf(`order ${order.id}`)
    .step("validate", TASKS.validate)
    .step("charge", TASKS.charge, {
      after: ["validate"],
      // Partial per-step config: short, jittered exponential backoff so the
      // retry storm is watchable in seconds rather than minutes.
      config: { max_retries: 4, retry_delay_secs: 2, retry_max_delay_secs: 15, jitter_factor: 0.2 },
    })
    .step("fraud", TASKS.fraud, {
      after: ["validate"],
      config: { max_retries: 0 },
      onFailure: "halt", // fraud kills the whole order
    })
    .step("reserve", TASKS.reserve, { after: ["charge", "fraud"] }) // fan-in
    .step("invoice", TASKS.invoice, { after: ["reserve"] })
    .step("confirm", TASKS.confirm, {
      after: ["invoice"],
      config: { max_retries: 1, retry_delay_secs: 2 },
      onFailure: "skip", // a bounced email must not block shipping
    })
    .step("warehouse", TASKS.warehouse, { after: ["invoice"] })
    .context({ order: { ...order } })
    .metadata({ app: "shipit" });
}
