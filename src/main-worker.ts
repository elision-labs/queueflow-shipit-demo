/** Entry point: the Node worker as its own process (`npm run worker`).
 * Kill it mid-order to watch the janitor reclaim the expired lease and
 * redeliver the step to the next worker. */

import { startWorker } from "./worker.js";

const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n[worker] ${sig}: draining (in-flight job finishes, lease-expiry covers the rest)`);
    stop.abort();
  });
}

startWorker(stop.signal)
  .then(() => {
    console.log("[worker] stopped");
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[worker] fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
