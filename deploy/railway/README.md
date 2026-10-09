# Railway deployment runbook

The public demo at https://demo.queueflow.dev runs on Railway as project
`queueflow-shipit-demo` (workspace Orynn, environment `production`). This
document matches the live project as inspected on 2026-10-09; the same shape
is expressed as code in [`.railway/railway.ts`](../../.railway/railway.ts).

Railway's `railway.json` / `railway.toml` config-as-code is deprecated (new
services cannot opt in; the hard cutoff is 2026-12-01), so this repo uses the
replacement, Infrastructure as Code (`.railway/railway.ts`). No service uses a
Dockerfile: the three app services build with Railpack from the uploaded
sources, and the engine runs the published image.

## Services

| Service | Source | Root / upload | Start command | Exposure |
| --- | --- | --- | --- | --- |
| `Postgres` | Railway managed Postgres | n/a | n/a | private |
| `engine` | image `ghcr.io/elision-labs/queueflow:0.1` | n/a | image entrypoint (`queueflow serve`, configured by `QUEUEFLOW_*` env vars) | private, `http://engine.railway.internal:8000` |
| `web` | `railway up --service web` from the repo root | repo root | `npm run web` | public, custom domain `demo.queueflow.dev` on port 3100 |
| `worker-node` | `railway up --service worker-node` from the repo root | repo root | `npm run worker` | none |
| `worker-py` | `railway up ./worker-py --path-as-root --service worker-py` | `worker-py/` | `python worker.py` | none |

Deploys are manual `railway up` calls (no Git trigger). Rebuild and redeploy
one service with the command in its row; the CLI lives at
`~/.railway/bin/railway` on the maintainer's machine.

## Variables

Values are random and live only on Railway. Set them in the dashboard or with
`railway variable set --service <name> KEY=value` before deploying code that
requires them. `preserve()` in `.railway/railway.ts` keeps whatever is set.

### `engine`

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `QUEUEFLOW_MODE` | `api` |
| `QUEUEFLOW_DEFAULT_QUEUE` | `orders` |
| `QUEUEFLOW_RETENTION_HOURS` | `168` |
| `QUEUEFLOW_API_KEYS` | `<tenant key>:shipit` (secret) |
| `QUEUEFLOW_WORKER_TOKEN` | `<worker token>` (secret) |
| `RUST_LOG` | `info` |

### `web`

| Variable | Value | Required |
| --- | --- | --- |
| `QUEUEFLOW_URL` | `http://engine.railway.internal:8000` | yes (defaults to localhost otherwise) |
| `QUEUEFLOW_TOKEN` | the key part of the engine's `QUEUEFLOW_API_KEYS` | yes, process exits without it |
| `QUEUEFLOW_WORKER_TOKEN` | same as the engine's `QUEUEFLOW_WORKER_TOKEN` | yes, process exits without it |
| `SHIPIT_ADMIN_TOKEN` | random bearer token for DLQ replay and cron pause/resume | no; unset means those actions answer 503 |
| `PORT` | `3100` | matches the domain's target port |
| `PAYMENT_FAILURE_RATE` | `0.25` or similar | no (default 0.25) |
| `RATE_LIMIT_PER_MINUTE` | per-IP budget for mutating `/api` calls | no (default 20) |

The web process trusts one `X-Forwarded-For` hop automatically when
`RAILWAY_SERVICE_ID` or `RAILWAY_ENVIRONMENT_ID` is present (Railway injects
both into every service), so the rate limiter keys on the real client address.
Do not set `TRUST_PROXY` on Railway.

### `worker-node` and `worker-py`

| Variable | Value | Required |
| --- | --- | --- |
| `QUEUEFLOW_URL` | `http://engine.railway.internal:8000` | yes |
| `QUEUEFLOW_TOKEN` | tenant key | yes, process exits without it |
| `QUEUEFLOW_WORKER_TOKEN` | worker token | yes, process exits without it |
| `PAYMENT_FAILURE_RATE` | `0.25` or similar | no (only the Node worker reads it) |

## Applying the IaC file

```bash
npm install                 # installs the `railway` SDK used by .railway/railway.ts
railway link                # pick queueflow-shipit-demo / production
railway config plan         # read-only diff; expect no changes on a clean import
railway config apply        # only after reviewing the plan
```

A whole-project file deletes resources it omits, so review the plan line by
line. `railway config pull --force` regenerates the file from the live
environment if the two drift.
