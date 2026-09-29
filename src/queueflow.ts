/** One shared QueueFlow client for the web process and the Node worker. */

import { QueueFlow } from "@queueflow/sdk";
import { config } from "./config.js";

export const qf = new QueueFlow({
  baseUrl: config.queueflowUrl,
  token: config.token,
  // Worker-protocol routes (lease/heartbeat/complete/fail) authenticate with
  // the worker credential; the server refuses tenant tokens there.
  workerToken: config.workerToken,
  timeoutMs: 10_000,
});
