#!/usr/bin/env bash
# Runs the end-to-end tests against a throwaway stack of their own: compose project
# po-e2e, image po-api:e2e and their own ports, so the default stack (po-api:local and
# its containers and volumes) is never rebuilt, replaced or removed. Secrets come from
# .env (cp .env.example .env, or scripts/ci-env.sh). CI runs the default stack instead.
set -euo pipefail

cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=po-e2e
export API_IMAGE_TAG=e2e
export COMPOSE_PROFILES=local
export WEB_PORT=18080
export MAILPIT_PORT=18025
export APP_ORIGIN=http://localhost:${WEB_PORT}
export E2E_BASE_URL=${APP_ORIGIN}
export MAILPIT_URL=http://127.0.0.1:${MAILPIT_PORT}

trap 'docker compose down -v' EXIT
docker compose up -d --build --wait --wait-timeout 300
npm run e2e -- "$@"
