# Ship-It — the QueueFlow order-pipeline demo

A tiny storefront where **every order is a workflow**. Place one and watch it
move through a seven-step DAG — validated, charged (flakily), fraud-screened,
reserved, invoiced, confirmed, and handed to a warehouse — executed by a
**Node worker** and a **Python worker** against one QueueFlow engine. The
point of the app is the window it gives you into the machinery: live step
states, visible retries with exponential backoff, failure policies doing
different things on purpose, a dead-letter shelf with one-click replay.

```
                 ┌─ charge_payment ──┐                         ┌─ send_confirmation   (skip on failure)
validate_order ──┤                   ├─ reserve ─ invoice ─────┤
                 └─ fraud_check ─────┘                         └─ notify_warehouse ──→ pack_order
                    (halt on failure)                                                  (Python, own queue)
```

## What each product demonstrates

| Product | Scenario |
| --- | --- |
| **Anvil, 40 lb** | The happy path, with ambient payment chaos (`PAYMENT_FAILURE_RATE`, default 0.25). |
| **Bubble wrap, 1 km** | A deterministic retry storm: payment fails 3 times, backs off exponentially with jitter, then clears. Watch the attempt tallies. |
| **Suspicious briefcase** | A fraud halt: `NonRetryableError` → job dead-letters, the step's `halt` policy fails the workflow and skips everything downstream. Replay it from the dispatch office. |
| *"this mailbox bounces"* | The skip policy: the confirmation email fails twice and dead-letters, but the order still ships — the workflow ends `partially_failed`. |

## Run it

Requirements: Docker, Node 18+, Python 3.10+.

```bash
make demo        # engine up (first run compiles Rust in Docker) + workers + smoke test
```

Then, in three terminals:

```bash
make web         # storefront http://localhost:3100, dispatch office /admin.html
make worker      # the Node worker (orders queue)
make worker-py   # the Python worker (warehouse queue)
```

Place orders and watch the waybill. Everything the UI shows comes from the
engine's HTTP API through [`@queueflow/sdk`](https://www.npmjs.com/package/@queueflow/sdk)
(npm) and [`queueflow`](https://pypi.org/project/queueflow/) (PyPI) — there is
no app database. The only sibling checkout still required is
`queueflow-core-rs`, which `make up` builds the engine image from.

## A five-minute tour

1. **Order the bubble wrap.** The payment station shows attempt tallies and a
   "retrying in ~Ns" countdown as the engine applies the step's own backoff
   config (`max_retries: 4, retry_delay_secs: 2, jitter: 0.2` — a *partial*
   per-step config; the engine fills the defaults).
2. **Kill the Node worker mid-order** (`Ctrl-C` on `make worker`, then restart
   it). The in-flight step's lease expires, the janitor reclaims it, and the
   restarted worker finishes the order. At-least-once delivery is why every
   handler is idempotent.
3. **Order the briefcase.** The fraud screen rejects it permanently: the route
   stamps REJECTED, downstream stations are skipped, and the job lands on the
   dispatch office's *damaged parcels* shelf. Replay it from there.
4. **Tick "this mailbox bounces"** on any order: the confirmation is skipped,
   the parcel still gets packed by the Python worker, and the waybill stamps
   FULFILLED* (`partially_failed`).
5. **Open the dispatch office.** The manifest pages by keyset cursor (`Load
   next page`), the counters are the engine's live stats, and the standing
   `abandoned-cart-sweep` cron (registered by the web process on boot, fires
   every minute) can be paused and resumed.

Also quietly happening: every completed order schedules a `review_request`
job 90 seconds out (`runAt` — a demo-compressed "7 days") guarded by an
idempotency key, so the at-least-once warehouse hand-off can never enqueue it
twice.

## How it's wired

| Piece | Where | Notes |
| --- | --- | --- |
| Engine | docker compose (`queueflow serve --mode api`) | No in-process workers: everything runs through the remote worker protocol. Strict auth: tenant key `shipit-key`, worker token `shipit-worker-token`. |
| Storefront + API | `src/server.ts` (Express) | Proxies the SDK; streams order snapshots to the browser over SSE. |
| Order pipeline | `src/pipeline.ts` | The DAG, per-step configs, and failure policies. |
| Node worker | `src/worker.ts` | Leases `orders`; heartbeats at lease/2 via `qf.worker.run`. |
| Python worker | `worker-py/worker.py` | Leases `warehouse` with the generated Python SDK; the polyglot half. |
| Smoke test | `scripts/smoke.ts` | Spawns both workers and proves all four scenarios end to end. |
