/** Environment-driven configuration, with docker-compose defaults. */

export const config = {
  queueflowUrl: process.env.QUEUEFLOW_URL ?? "http://localhost:8000",
  /** Tenant credential (matches the server's `--api-keys shipit-key:shipit`). */
  token: process.env.QUEUEFLOW_TOKEN ?? "shipit-key",
  /** Worker credential (matches the server's `--worker-token`). */
  workerToken: process.env.QUEUEFLOW_WORKER_TOKEN ?? "shipit-worker-token",
  port: Number(process.env.PORT ?? 3100),
  /**
   * Ambient chaos: probability that any single payment attempt fails.
   * Bubble Wrap orders ignore this and fail deterministically (see worker.ts).
   */
  paymentFailureRate: Number(process.env.PAYMENT_FAILURE_RATE ?? 0.25),
} as const;

/**
 * The engine schedules workflow-step jobs on its default queue, so the Node
 * worker leases from it. The server is started with `--default-queue orders`.
 */
export const ORDERS_QUEUE = "orders";

/** Hand-off queue consumed by the Python warehouse worker (worker-py/). */
export const WAREHOUSE_QUEUE = "warehouse";
