#!/usr/bin/env bash
# Runs the end-to-end tests against a throwaway stack of their own: compose project
# po-e2e, image po-api:e2e and their own ports, so the default stack (po-api:local and
# its containers and volumes) is never rebuilt, replaced or removed. Its env file is a
# throwaway one with random secrets (scripts/ci-env.sh), so the owner's .env is never read.
# CI runs the default stack instead.
set -euo pipefail

cd "$(dirname "$0")/.."

export COMPOSE_ENV_FILES="$(mktemp)"
CI_ENV_FILE="$COMPOSE_ENV_FILES" scripts/ci-env.sh --force
export COMPOSE_PROJECT_NAME=po-e2e
export API_IMAGE_TAG=e2e
export COMPOSE_PROFILES=local
export WEB_PORT=18080
export MAILPIT_PORT=18025
export APP_ORIGIN=http://localhost:${WEB_PORT}
export E2E_BASE_URL=${APP_ORIGIN}
export MAILPIT_URL=http://127.0.0.1:${MAILPIT_PORT}

trap 'docker compose down -v; rm -f "$COMPOSE_ENV_FILES"' EXIT
docker compose up -d --build --wait --wait-timeout 300
npm run e2e -w @po/frontend -- "$@"
