#!/bin/sh
# Runs the whole test suite in Docker (Postgres + pgvector, Node 24) and always cleans up.
set -eu
cd "$(dirname "$0")/.."
compose="docker compose -f docker-compose.test.yml -p shared-memory-mcp-test"
trap '$compose down -v --remove-orphans >/dev/null 2>&1' EXIT
$compose up --abort-on-container-exit --exit-code-from test --quiet-pull
