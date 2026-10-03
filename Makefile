# Ship-It: the QueueFlow order-pipeline demo.
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

.PHONY: up down install web worker worker-py smoke demo dev-server

up:
	docker compose up -d --build --wait

down:
	docker compose down -v

install: node_modules $(PY_VENV)

node_modules: package.json
	npm install

$(PY_VENV): worker-py/requirements.txt
	python3 -m venv $(PY_VENV)
	$(PY_VENV)/bin/pip install -q -r worker-py/requirements.txt

web: node_modules
	npm run web

worker: node_modules
	npm run worker

worker-py: $(PY_VENV)
	$(PY_VENV)/bin/python worker-py/worker.py

smoke: install
	npm run smoke

demo: up install smoke

# Alternative to the composed engine while hacking on queueflow-core-rs:
# postgres from compose, the server from the sibling checkout.
dev-server:
	docker compose up -d --wait postgres
	cd ../queueflow-core-rs && DATABASE_URL=postgres://queueflow:queueflow@localhost:5433/queueflow \
		cargo run -q -p queueflow -- serve --mode api --default-queue orders \
		--api-keys shipit-key:shipit --worker-token shipit-worker-token --retention-hours 168
