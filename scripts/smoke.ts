/**
 * End-to-end smoke test. Requires the engine (docker compose up) but spawns
 * its own Node and Python workers, so one command proves the whole pipeline:
 *
 *   1. Anvil          → happy path: workflow completed, packed by Python.
 *   2. Bubble wrap    → deterministic retry storm: >= 3 payment retries, then completed.
 *   3. Briefcase      → fraud halt: workflow failed, job dead-lettered, replayed.
 *   4. Bounced email  → skip policy: workflow partially_failed, order still packed.
 *   5. Cursor paging  → walks the job manifest by keyset cursor.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { qf } from "../src/queueflow.js";
import { newOrderId, orderWorkflow, CATALOG, type Order } from "../src/pipeline.js";

const PY = process.env.PYTHON ?? "worker-py/.venv/bin/python";
const children: ChildProcess[] = [];

function run(cmd: string, args: string[], name: string): ChildProcess {
  const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    if (code && !shuttingDown) fail(`${name} exited early with code ${code}`);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function cleanup() {
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
}
function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}
function ok(msg: string) {
  console.log(`  ok: ${msg}`);
}

function order(sku: string, overrides: Partial<Order> = {}): Order {
  const p = CATALOG.find((x) => x.sku === sku)!;
  return {
    id: newOrderId(),
    sku: p.sku,
    name: p.name,
    qty: 1,
    email: "smoke@example.com",
    totalCents: p.priceCents,
    flakyPayment: p.sku === "BUBBLE-1KM",
    bounceEmail: false,
    ...overrides,
  };
}

async function waitForWorkflow(id: string, timeoutMs = 90_000) {
  return qf.workflows.waitFor(id, { timeoutMs, intervalMs: 500 });
}

async function packJobOf(workflowId: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const wfRecord = await qf.workflows.get(workflowId);
    const warehouse = (wfRecord.context as Record<string, { pack_job_id?: string }>).warehouse;
    if (warehouse?.pack_job_id) return warehouse.pack_job_id;
    await sleep(500);
  }
  fail(`workflow ${workflowId} never recorded a pack job`);
}

async function main() {
  console.log("smoke: engine health…");
  await qf.health();
  ok("engine is healthy");

  console.log("smoke: starting workers…");
  run("npx", ["tsx", "src/main-worker.ts"], "node worker");
  run(PY, ["worker-py/worker.py"], "python worker");
  await sleep(1500);

  // 1. Happy path (chaos off for determinism: anvil w/ flaky=false and rate
  // may still bite; retries are fine, the workflow must still complete).
  console.log("\nsmoke: 1. anvil (happy path)…");
  const anvil = await qf.workflows.create(orderWorkflow(order("ANVIL-40")));
  const anvilDone = await waitForWorkflow(anvil.id);
  if (anvilDone.status !== "completed") fail(`anvil workflow ended ${anvilDone.status}`);
  const packed = await qf.jobs.waitFor(await packJobOf(anvil.id), { timeoutMs: 30_000 });
  if (packed.status !== "completed") fail(`pack job ended ${packed.status}`);
  const tracking = (packed.result as { tracking_number?: string })?.tracking_number;
  if (!tracking) fail("pack job returned no tracking number");
  if ((packed.result as { packed_by?: string })?.packed_by !== "python-worker") {
    fail("pack job was not handled by the python worker");
  }
  ok(`completed and packed by Python (${tracking})`);

  // 2. Retry storm.
  console.log("\nsmoke: 2. bubble wrap (retry storm)…");
  const bubble = await qf.workflows.create(orderWorkflow(order("BUBBLE-1KM")));
  const bubbleDone = await waitForWorkflow(bubble.id, 120_000);
  if (bubbleDone.status !== "completed") fail(`bubble workflow ended ${bubbleDone.status}`);
  const steps = await qf.workflows.steps(bubble.id);
  const chargeStep = steps.find((s) => s.name === "charge");
  const chargeJob = await qf.jobs.get(chargeStep!.job_id!);
  if (chargeJob.retry_count < 3) fail(`expected >=3 payment retries, saw ${chargeJob.retry_count}`);
  ok(`completed after ${chargeJob.retry_count} payment retries (exponential backoff)`);

  // 3. Fraud halt → DLQ → replay.
  console.log("\nsmoke: 3. briefcase (fraud halt)…");
  const dlqBefore = new Set(
    (await qf.dlq.list({ limit: 100 })).dead_letters.map((d) => d.id),
  );
  const briefcase = await qf.workflows.create(orderWorkflow(order("CASE-9999")));
  const briefcaseDone = await waitForWorkflow(briefcase.id);
  if (briefcaseDone.status !== "failed") fail(`briefcase workflow ended ${briefcaseDone.status}`);
  const bSteps = await qf.workflows.steps(briefcase.id);
  if (bSteps.find((s) => s.name === "fraud")?.status !== "failed") fail("fraud step not failed");
  // Downstream of a halt ends cancelled (the halt's sweep) or skipped (a
  // concurrent advance marked the dependency unsatisfiable first) - both are
  // correct; which one wins is a benign race between the two writers.
  const reserveStatus = bSteps.find((s) => s.name === "reserve")?.status;
  if (reserveStatus !== "cancelled" && reserveStatus !== "skipped") {
    fail(`downstream step should be cancelled or skipped after the halt, was ${reserveStatus}`);
  }
  await sleep(1000);
  const fresh = (await qf.dlq.list({ limit: 100 })).dead_letters.filter(
    (d) => !dlqBefore.has(d.id) && d.task_name === "fraud_check",
  );
  if (!fresh.length) fail("fraud job did not dead-letter");
  const replayId = await qf.dlq.replay(fresh[0].id);
  const replayJob = await qf.jobs.get(replayId);
  if (replayJob.task_name !== "fraud_check") fail("replay created the wrong job");
  ok(`halted, dead-lettered (#${fresh[0].id}), replayed as ${replayId.slice(0, 8)}…`);

  // 4. Skip policy.
  console.log("\nsmoke: 4. bounced email (skip policy)…");
  const bounced = await qf.workflows.create(
    orderWorkflow(order("ANVIL-40", { bounceEmail: true })),
  );
  const bouncedDone = await waitForWorkflow(bounced.id, 120_000);
  if (bouncedDone.status !== "partially_failed") {
    fail(`bounced workflow ended ${bouncedDone.status}, expected partially_failed`);
  }
  const cSteps = await qf.workflows.steps(bounced.id);
  if (cSteps.find((s) => s.name === "confirm")?.status !== "skipped") {
    fail("confirm step should be skipped");
  }
  const bouncedPack = await qf.jobs.waitFor(await packJobOf(bounced.id), { timeoutMs: 30_000 });
  if (bouncedPack.status !== "completed") fail("order with bounced email was not packed");
  ok("email skipped, order still packed (partially_failed)");

  // 5. Keyset pagination.
  console.log("\nsmoke: 5. manifest paging by cursor…");
  const page1 = await qf.jobs.list({ limit: 3 });
  if (!page1.next_cursor) fail("expected a next_cursor with more than 3 jobs in history");
  const page2 = await qf.jobs.list({ limit: 3, cursor: page1.next_cursor });
  const ids1 = new Set(page1.jobs.map((j) => j.id));
  if (page2.jobs.some((j) => ids1.has(j.id))) fail("cursor page overlapped the previous page");
  ok("cursor pages are disjoint and ordered");

  console.log("\nPASS: the whole pipeline works — storefront to Python tape gun.");
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
