"""Ship-It's warehouse worker: Python, leasing from the `warehouse` queue.

This is the polyglot half of the demo, built on the Python SDK's worker
runtime (`run_worker`, queueflow >= 0.2): it leases jobs, heartbeats each one
at half the lease interval while the handler runs, and reports the outcome.
The engine still owns retries, the dead-letter queue, and scheduling.

Delivery is at-least-once: pack_order is idempotent (re-packing prints a
duplicate tracking number and nothing else breaks).
"""

from __future__ import annotations

import logging
import os
import random
import signal
import string
import sys
import threading
import time

from queueflow.facade import QueueFlow



def require_env(name: str) -> str:
    """Credentials have no defaults: stop at startup and name the variable."""
    value = os.environ.get(name)
    if not value:
        sys.exit(
            f"[warehouse] {name} is not set. Copy .env.example to .env and fill it in "
            "(or set the variable on the service), then start again."
        )
    return value


BASE_URL = os.environ.get("QUEUEFLOW_URL", "http://localhost:8000")
TOKEN = require_env("QUEUEFLOW_TOKEN")
WORKER_TOKEN = require_env("QUEUEFLOW_WORKER_TOKEN")
QUEUE = "warehouse"

logging.basicConfig(level=logging.INFO, format="[warehouse] %(message)s")


def tracking_number() -> str:
    return "1Z-SHIP-" + "".join(random.choices(string.digits, k=8))


def pack_order(job, ctx) -> dict:
    order = (job.payload or {}).get("order", {})
    order_id = order.get("id", "unknown")
    print(f"[warehouse] packing {order_id}: {order.get('qty')} x {order.get('sku')}", flush=True)
    time.sleep(1.5)  # tape gun noises
    if ctx.cancelled:  # lease lost / order cancelled mid-pack: stop here
        return {}
    tn = tracking_number()
    print(f"[warehouse] {order_id} packed, tracking {tn}", flush=True)
    return {"tracking_number": tn, "packed_by": "python-worker"}


def main() -> int:
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    # worker_token routes the worker-protocol calls through the worker
    # credential; the tenant token stays on everything else.
    qf = QueueFlow(BASE_URL, TOKEN, worker_token=WORKER_TOKEN)
    print(f"[warehouse] leasing '{QUEUE}' from {BASE_URL}", flush=True)
    qf.run_worker(QUEUE, {"pack_order": pack_order}, stop=stop)
    print("[warehouse] stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
