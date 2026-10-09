# Ship-It: the QueueFlow order-pipeline demo.
#
#   cp .env.example .env   first: fill in QUEUEFLOW_TOKEN and QUEUEFLOW_WORKER_TOKEN
#
#   make up        engine + postgres via docker compose (pulls the published engine image)
#   make install   node deps + python venv for the warehouse worker
#   make demo      up + install + end-to-end smoke test (spawns its own workers)
#   make web       storefront + dispatch office on :3100
#   make worker    the Node worker (orders queue)
#   make worker-py the Python worker (warehouse queue)
#   make down      stop everything, drop the database

SHELL := /bin/bash
PY_VENV := worker-py/.venv

# Every app process reads its credentials from .env (docker compose reads the
# same file on its own). Nothing in the repo falls back to a known secret.
LOAD_ENV := set -a; [ -f .env ] && . ./.env; set +a;

.PHONY: up down install web worker worker-py smoke demo dev-server env-check

env-check:
	@test -f .env || { echo "No .env found. Run: cp .env.example .env  (then fill in the tokens)"; exit 1; }

up: env-check
	docker compose up -d --wait

down:
	docker compose down -v

install: node_modules $(PY_VENV)

node_modules: package.json
	npm install

$(PY_VENV): worker-py/requirements.txt
	python3 -m venv $(PY_VENV)
	$(PY_VENV)/bin/pip install -q -r worker-py/requirements.txt

web: node_modules env-check
	$(LOAD_ENV) npm run web

worker: node_modules env-check
	$(LOAD_ENV) npm run worker

worker-py: $(PY_VENV) env-check
	$(LOAD_ENV) $(PY_VENV)/bin/python worker-py/worker.py

smoke: install env-check
	$(LOAD_ENV) npm run smoke

demo: up install smoke

# Alternative to the composed engine while hacking on queueflow-core-rs:
# postgres from compose, the server from the sibling checkout.
dev-server: env-check
	docker compose up -d --wait postgres
	$(LOAD_ENV) cd ../queueflow-core-rs && DATABASE_URL=postgres://queueflow:queueflow@localhost:5433/queueflow \
		cargo run -q -p queueflow -- serve --mode api --default-queue orders \
		--api-keys $$QUEUEFLOW_TOKEN:shipit --worker-token $$QUEUEFLOW_WORKER_TOKEN --retention-hours 168
