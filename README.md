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
| **Suspicious briefcase** | A fraud halt: `NonRetryableError` → job dead-letters, the step's `halt` policy fails the workflow and cancels the remaining steps. Replay it from the dispatch office. |
| *"this mailbox bounces"* | The skip policy: the confirmation email fails twice and dead-letters, but the order still ships — the workflow ends `partially_failed`. |

## Run it

Requirements: Docker, Node 18+, Python 3.10+.

```bash
cp .env.example .env     # then fill in QUEUEFLOW_TOKEN and QUEUEFLOW_WORKER_TOKEN
make demo                # engine up (pulls ghcr.io/elision-labs/queueflow) + workers + smoke test
```

Nothing in the repo falls back to a known credential: docker compose refuses
to start the engine until both tokens are in `.env`, and each app process exits
at startup naming the variable it is missing. `openssl rand -hex 24` mints a
fine value. `.env.example` documents every variable.

Then, in three terminals:

```bash
make web         # storefront http://localhost:3100, dispatch office /admin.html
make worker      # the Node worker (orders queue)
make worker-py   # the Python worker (warehouse queue)
```

Place orders and watch the waybill. Everything the UI shows comes from the
engine's HTTP API through [`@queueflow/sdk`](https://www.npmjs.com/package/@queueflow/sdk)
(npm) and [`queueflow`](https://pypi.org/project/queueflow/) (PyPI) — there is
no app database. The engine itself runs from the published
[`ghcr.io/elision-labs/queueflow`](https://github.com/elision-labs/queueflow-core/pkgs/container/queueflow)
image, so no sibling checkout is needed to run the demo at all (only to hack
on the engine — see `make dev-server`).

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
   stamps REJECTED, the remaining stations are cancelled, and the job lands on
   the dispatch office's *damaged parcels* shelf. Replay it from there (this
   needs the admin token, see below).
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
| Engine | docker compose (`queueflow serve --mode api`) | No in-process workers: everything runs through the remote worker protocol. Strict auth: the tenant key and worker token come from `.env` (`QUEUEFLOW_TOKEN`, `QUEUEFLOW_WORKER_TOKEN`). |
| Storefront + API | `src/server.ts` (Express) | Proxies the SDK; streams order snapshots to the browser over SSE. `src/guards.ts` holds the admin bearer check and the rate limiter. |
| Order pipeline | `src/pipeline.ts` | The DAG, per-step configs, and failure policies. |
| Node worker | `src/worker.ts` | Leases `orders`; heartbeats at lease/2 via `qf.worker.run`. |
| Python worker | `worker-py/worker.py` | Leases `warehouse` through the Python SDK's `run_worker` ([`queueflow`](https://pypi.org/project/queueflow/) >= 0.2); the polyglot half. |
| Smoke test | `scripts/smoke.ts` | Spawns both workers and proves all four scenarios end to end. |

## Running it in public

The demo at [demo.queueflow.dev](https://demo.queueflow.dev) is open to anyone,
so the web process carries two guards:

- **Admin token.** Mutating dispatch-office calls (`POST /api/admin/dlq/:id/replay`,
  `POST /api/admin/crons/:id/pause|resume`) require
  `Authorization: Bearer <SHIPIT_ADMIN_TOKEN>`. The dispatch office has an
  *admin token* field that keeps the value in your browser's localStorage and
  sends it on those calls; a wrong or missing token gets a 401 with a plain
  message. If the operator never set `SHIPIT_ADMIN_TOKEN`, those calls answer
  503 and explain why. Every read-only admin view (counters, manifest, dead
  letters, crons) stays open.
- **Rate limit.** Every mutating `/api` route (placing orders included) shares
  an in-memory per-IP budget of `RATE_LIMIT_PER_MINUTE` requests per 60 s
  (default 20), answering 429 with `Retry-After` beyond that. Reads and the SSE
  tracker are not counted. `X-Forwarded-For` is trusted for one hop only when
  Railway's injected `RAILWAY_SERVICE_ID` / `RAILWAY_ENVIRONMENT_ID` is present
  or `TRUST_PROXY=1` is set; otherwise the socket address is used.

Environment variables, in one place:

| Variable | Who reads it | Required | Notes |
| --- | --- | --- | --- |
| `QUEUEFLOW_TOKEN` | engine (compose), web, both workers | yes | tenant key; the engine gets it as `--api-keys $QUEUEFLOW_TOKEN:shipit` |
| `QUEUEFLOW_WORKER_TOKEN` | engine (compose), web, both workers | yes | worker-protocol credential |
| `QUEUEFLOW_URL` | web, both workers | no | default `http://localhost:8000` |
| `SHIPIT_ADMIN_TOKEN` | web | no | enables DLQ replay and cron pause/resume |
| `PORT` | web | no | default 3100 |
| `RATE_LIMIT_PER_MINUTE` | web | no | default 20 |
| `TRUST_PROXY` | web | no | `1` to honour one `X-Forwarded-For` hop off Railway |
| `PAYMENT_FAILURE_RATE` | Node worker | no | default 0.25 |

The Railway deployment is described as code in `.railway/railway.ts`, with a
per-service runbook in [`deploy/railway/README.md`](deploy/railway/README.md).
