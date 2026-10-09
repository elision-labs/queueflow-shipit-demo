/**
 * Railway Infrastructure as Code for the Ship-It demo (demo.queueflow.dev).
 *
 * One file describes the whole `queueflow-shipit-demo` project, so omitting a
 * resource here deletes it on apply. Workflow (read-only until the last step):
 *
 *   npm install                      # pulls the `railway` SDK (devDependency)
 *   railway link                     # once, from the repo root
 *   railway config plan              # diff against the live environment
 *   railway config apply             # after reviewing the plan
 *
 * Secrets are `preserve()`d: their values stay on Railway and never enter the
 * repo. Set them in the dashboard (or `railway variable set`) before applying.
 * See deploy/railway/README.md for the per-service runbook.
 */

import { defineRailway, image, postgres, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const db = postgres("Postgres");

  // The engine runs from the published image and is configured entirely by
  // env vars (one QUEUEFLOW_* variable per CLI flag). Not publicly exposed:
  // the app processes reach it over the private network.
  const engine = service("engine", {
    source: image("ghcr.io/elision-labs/queueflow:0.1"),
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      QUEUEFLOW_MODE: "api",
      QUEUEFLOW_DEFAULT_QUEUE: "orders",
      QUEUEFLOW_RETENTION_HOURS: "168",
      RUST_LOG: "info",
      // "<tenant key>:shipit" and the worker credential: random, Railway-only.
      QUEUEFLOW_API_KEYS: preserve(),
      QUEUEFLOW_WORKER_TOKEN: preserve(),
    },
  });

  // Shared by the three app processes. QUEUEFLOW_URL is the engine's private
  // address, http://engine.railway.internal:8000. The two credentials must
  // match the engine's QUEUEFLOW_API_KEYS key part and QUEUEFLOW_WORKER_TOKEN.
  const appEnv = {
    QUEUEFLOW_URL: preserve(),
    QUEUEFLOW_TOKEN: preserve(),
    QUEUEFLOW_WORKER_TOKEN: preserve(),
    PAYMENT_FAILURE_RATE: preserve(),
  };

  // No `source`: these three are uploaded with `railway up` from the repo
  // (see deploy/railway/README.md), and Railpack builds them. Connect a GitHub
  // source here if the project ever moves to Git-triggered deploys.
  const web = service("web", {
    start: "npm run web",
    domains: [{ domain: "demo.queueflow.dev", port: 3100 }],
    env: {
      ...appEnv,
      PORT: "3100",
      // Bearer token for DLQ replay and cron pause/resume in the dispatch
      // office. Without it those actions answer 503; reads stay open.
      SHIPIT_ADMIN_TOKEN: preserve(),
    },
  });

  const workerNode = service("worker-node", {
    start: "npm run worker",
    env: appEnv,
  });

  // Uploaded with `railway up ./worker-py --path-as-root`, so the start
  // command runs with worker-py/ as the working directory.
  const workerPy = service("worker-py", {
    start: "python worker.py",
    env: appEnv,
  });

  return project("queueflow-shipit-demo", {
    resources: [db, engine, web, workerNode, workerPy],
  });
});
