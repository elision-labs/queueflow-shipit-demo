/** Entry point: the storefront + dispatch-office web process. */

import { startWeb } from "./server.js";

startWeb().catch((err) => {
  console.error(`[web] failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
