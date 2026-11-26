#!/usr/bin/env bash
# The brief's §8 load test (ADR-0012, amended 2026-11-26): `npm run load`. A throwaway
# stack of its own, as scripts/e2e-local.sh builds one: compose project po-load, image
# po-api:load, its own ports and TLS edge, and a throwaway env file with random secrets
# (scripts/ci-env.sh), so neither the default stack nor the e2e one is touched. The stack,
# its volumes and the env file are removed at the end, pass or fail. Never on pull requests.
set -euo pipefail

cd "$(dirname "$0")/../.."

export COMPOSE_ENV_FILES="$(mktemp)"
CI_ENV_FILE="$COMPOSE_ENV_FILES" scripts/ci-env.sh --force
export COMPOSE_PROJECT_NAME=po-load
export API_IMAGE_TAG=load
export COMPOSE_PROFILES=local
export WEB_PORT=19080
export MAILPIT_PORT=19025
export E2E_TLS_PORT=19443
export COMPOSE_FILE=docker-compose.yml:deploy/e2e/compose.tls.yml
export APP_ORIGIN=https://localhost:${E2E_TLS_PORT}
export MAILPIT_URL=http://127.0.0.1:${MAILPIT_PORT}
# The TLS edge's throwaway certificate is self-signed.
export NODE_TLS_REJECT_UNAUTHORIZED=0

trap 'docker compose down -v; rm -f "$COMPOSE_ENV_FILES"' EXIT
scripts/e2e-tls-cert.sh
docker compose up -d --build --wait --wait-timeout 300
node scripts/load/load.mjs
