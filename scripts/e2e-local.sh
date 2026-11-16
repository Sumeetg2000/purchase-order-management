#!/usr/bin/env bash
# Runs the end-to-end tests against a throwaway stack of their own: compose project
# po-e2e, image po-api:e2e and their own ports, so the default stack (po-api:local and
# its containers and volumes) is never rebuilt, replaced or removed. Its env file is a
# throwaway one with random secrets (scripts/ci-env.sh), so the owner's .env is never read.
# The browsers reach it over HTTPS through the e2e-only TLS edge (deploy/e2e), with a
# throwaway certificate made for the run. CI's e2e jobs use the same project and edge.
set -euo pipefail

cd "$(dirname "$0")/.."

export COMPOSE_ENV_FILES="$(mktemp)"
CI_ENV_FILE="$COMPOSE_ENV_FILES" scripts/ci-env.sh --force
export COMPOSE_PROJECT_NAME=po-e2e
export API_IMAGE_TAG=e2e
export COMPOSE_PROFILES=local
export WEB_PORT=18080
export MAILPIT_PORT=18025
export E2E_TLS_PORT=18443
export COMPOSE_FILE=docker-compose.yml:deploy/e2e/compose.tls.yml
export APP_ORIGIN=https://localhost:${E2E_TLS_PORT}
export E2E_BASE_URL=${APP_ORIGIN}
export MAILPIT_URL=http://127.0.0.1:${MAILPIT_PORT}

trap 'docker compose down -v; rm -f "$COMPOSE_ENV_FILES"' EXIT
scripts/e2e-tls-cert.sh
docker compose up -d --build --wait --wait-timeout 300
# The editor benchmark (@perf) times the browser, so on a throttled laptop it fails for the
# machine's reasons: CI runs every test, and locally it runs only on demand
# (npm run perf:editor, which passes --perf).
if [[ "${1:-}" == "--perf" ]]; then
  shift
  filter=(--grep @perf)
else
  filter=(--grep-invert @perf)
fi
npm run e2e -w @po/frontend -- "${filter[@]}" "$@"
