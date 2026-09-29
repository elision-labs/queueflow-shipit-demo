"""Ship-It's warehouse worker: Python, leasing from the `warehouse` queue.

This is the polyglot half of the demo. The Node worker runs the order
pipeline; this process picks up the hand-off (`pack_order`) over the same
remote worker protocol — lease, then complete/fail — using the generated
Python SDK. The engine still owns retries, the DLQ, and scheduling.

Heartbeats: a worker must extend its lease (heartbeat at ~lease/2) whenever a
handler can outlive the lease. Packing takes ~1.5s against a 30s lease, so
this loop skips heartbeating for brevity — see the SDK's FACADE.md for the
rules a long-running handler must follow.

Delivery is at-least-once: pack_order is idempotent (re-packing prints a
duplicate tracking number and nothing else breaks).
"""

from __future__ import annotations

import os
import random
import signal
import string
import sys
import time

from queueflow.facade import QueueFlow
from queueflow.models.complete_job_request import CompleteJobRequest
from queueflow.models.fail_job_request import FailJobRequest
from queueflow.models.lease_jobs_request import LeaseJobsRequest

BASE_URL = os.environ.get("QUEUEFLOW_URL", "http://localhost:8000")
TOKEN = os.environ.get("QUEUEFLOW_TOKEN", "shipit-key")
WORKER_TOKEN = os.environ.get("QUEUEFLOW_WORKER_TOKEN", "shipit-worker-token")
QUEUE = "warehouse"
LEASE_SECS = 30
WAIT_SECS = 20

running = True


def stop(signum, _frame):
    global running
    print(f"\n[warehouse] signal {signum}: draining", flush=True)
    running = False


def tracking_number() -> str:
    return "1Z-SHIP-" + "".join(random.choices(string.digits, k=8))


def pack_order(payload: dict) -> dict:
    order = (payload or {}).get("order", {})
    order_id = order.get("id", "unknown")
    print(f"[warehouse] packing {order_id}: {order.get('qty')} x {order.get('sku')}", flush=True)
    time.sleep(1.5)  # tape gun noises
    tn = tracking_number()
    print(f"[warehouse] {order_id} packed, tracking {tn}", flush=True)
    return {"tracking_number": tn, "packed_by": "python-worker"}


def main() -> int:
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    # worker_token routes qf.worker through the worker credential; the
    # tenant token stays on everything else.
    qf = QueueFlow(BASE_URL, TOKEN, worker_token=WORKER_TOKEN)
    print(f"[warehouse] leasing '{QUEUE}' from {BASE_URL}", flush=True)

    while running:
        try:
            leased = qf.worker.lease_jobs(
                QUEUE,
                LeaseJobsRequest(max_jobs=1, lease_secs=LEASE_SECS, wait_secs=WAIT_SECS),
            ).jobs
        except Exception as err:  # noqa: BLE001 - surface and back off
            print(f"[warehouse] lease failed: {err}", flush=True)
            time.sleep(1)
            continue

        for lease in leased:
            job = lease.job
            try:
                if job.task_name != "pack_order":
                    qf.worker.fail_job(
                        job.id,
                        FailJobRequest(
                            lease_token=lease.lease_token,
                            error=f"no warehouse handler for task '{job.task_name}'",
                            retryable=False,
                        ),
                    )
                    continue
                result = pack_order(job.payload or {})
                qf.worker.complete_job(
                    job.id,
                    CompleteJobRequest(lease_token=lease.lease_token, result=result),
                )
            except Exception as err:  # noqa: BLE001 - report, engine retries
                print(f"[warehouse] {job.id} failed: {err}", flush=True)
                try:
                    qf.worker.fail_job(
                        job.id,
                        FailJobRequest(lease_token=lease.lease_token, error=str(err)),
                    )
                except Exception as report_err:  # noqa: BLE001
                    # Never escalate a reporting error: the lease expires and
                    # the engine redelivers.
                    print(f"[warehouse] could not report failure: {report_err}", flush=True)

    print("[warehouse] stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
