#!/usr/bin/env bash
# Smoke test for the running compose stack (`docker compose up -d --wait` first).
# Checks service state, health and readiness through the edge, the SPA, the maintenance
# first run, Mailpit, and that /metrics is internal only (contracts/metrics.md).
# Prints the elapsed start time (SC-001): from SMOKE_STARTED_AT (epoch seconds, set
# before `docker compose up`) or, failing that, from the db container's start.
set -euo pipefail

cd "$(dirname "$0")/.."

WEB_PORT="${WEB_PORT:-$(sed -n 's/^WEB_PORT=//p' .env 2>/dev/null || true)}"
WEB_PORT="${WEB_PORT:-8080}"
BASE="http://127.0.0.1:${WEB_PORT}"
WAIT_SECONDS="${SMOKE_WAIT_SECONDS:-90}"

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

# Retries a check until it passes or WAIT_SECONDS elapse.
eventually() {
  local description="$1"
  shift
  local deadline=$((SECONDS + WAIT_SECONDS))
  until "$@" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      fail "$description"
      return 0
    fi
    sleep 2
  done
  pass "$description"
}

# One JSON object per container, as printed by `docker compose ps --format json`.
service_field() {
  local service="$1" field="$2"
  docker compose ps -a --format json "$service" |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const rows = s.trim().split("\n").filter(Boolean).flatMap((l) => [].concat(JSON.parse(l)));
        process.stdout.write(String(rows[0]?.[process.argv[1]] ?? ""));
      });
    ' "$field"
}

service_ok() {
  local state health
  state="$(service_field "$1" State)"
  health="$(service_field "$1" Health)"
  [[ "$state" == "running" && ("$health" == "" || "$health" == "healthy") ]]
}

migrate_ok() {
  [[ "$(service_field migrate State)" == "exited" && "$(service_field migrate ExitCode)" == "0" ]]
}

body_contains() {
  local url="$1" needle="$2"
  curl -fsS --max-time 5 "$url" | grep -q -- "$needle"
}

status_is() {
  local url="$1" expected="$2"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url")" == "$expected" ]]
}

serves_html() {
  local headers
  headers="$(curl -fsS --max-time 5 -D - -o /dev/null "$BASE/")"
  grep -qi '^content-type: text/html' <<<"$headers"
}

# Every host-published port of the project, as host:port.
published_ports() {
  docker compose ps --format json |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const rows = s.trim().split("\n").filter(Boolean).flatMap((l) => [].concat(JSON.parse(l)));
        const seen = new Set();
        for (const row of rows) {
          for (const p of row.Publishers ?? []) {
            if (p.PublishedPort > 0) seen.add(String(p.PublishedPort));
          }
        }
        process.stdout.write([...seen].join("\n"));
      });
    '
}

no_published_port_serves_metrics() {
  local port body
  local ports
  ports="$(published_ports)"
  [[ -n "$ports" ]] || return 1
  for port in $ports; do
    for path in /metrics /api/metrics /; do
      body="$(curl -s --max-time 5 "http://127.0.0.1:${port}${path}" || true)"
      if grep -q 'po_http_' <<<"$body"; then
        echo "port ${port}${path} serves Prometheus content" >&2
        return 1
      fi
    done
  done
}

internal_metrics() {
  docker compose exec -T web wget -qO- http://api:9464/metrics | grep -q 'po_http_requests_total'
}

# Sends one message through the API image's own mailer with the api container's validated
# config, then finds it in Mailpit: the API reaches the SMTP server it's configured with.
MAIL_SUBJECT="smoke check $(date +%s)-$$"
api_mail_reaches_mailpit() {
  docker compose exec -T api node --input-type=module -e '
    import { apiConfig } from "./dist/config/api.js";
    import { loadConfig } from "./dist/config/load.js";
    import { createSmtpMailer } from "./dist/mail/smtp.js";
    import { defineTemplate } from "./dist/mail/template.js";
    const config = loadConfig(apiConfig.schema);
    if (!config) process.exit(1);
    const subject = process.argv[1];
    const template = defineTemplate({
      name: "verify_email",
      subject: () => subject,
      text: () => "smoke",
      html: () => "<p>smoke</p>",
    });
    await createSmtpMailer(config).send({ template, to: "smoke@example.local", variables: {} });
  ' "$MAIL_SUBJECT" &&
    curl -fsS --max-time 5 http://127.0.0.1:8025/api/v1/messages | grep -qF "$MAIL_SUBJECT"
}

maintenance_ran() {
  docker compose logs --no-color maintenance | grep -q 'purge run complete'
}

# The edge answers its own errors as problem+json, with the registry's title and status
# and no correlationId (the API never saw the request).
edge_problem() {
  local expected_status="$1" code="$2" title="$3"
  shift 3
  local out status
  out="$(mktemp)"
  status="$(curl -s -o "$out" -D "$out.headers" -w '%{http_code}' --max-time 10 "$@")"
  local ok=0
  if [[ "$status" == "$expected_status" ]] &&
    grep -qi '^content-type: application/problem+json' "$out.headers" &&
    grep -q "\"code\":\"${code}\"" "$out" &&
    grep -q "\"title\":\"${title}\"" "$out" &&
    grep -q "\"status\":${expected_status}" "$out"; then
    ok=1
  fi
  rm -f "$out" "$out.headers"
  ((ok == 1))
}

oversized_post() {
  head -c $((3 * 1024 * 1024)) /dev/zero | tr '\0' 'x' >"${TMPDIR:-/tmp}/smoke-3mb.json"
  edge_problem 413 PAYLOAD_TOO_LARGE 'Payload too large' \
    -X POST -H 'Content-Type: application/json' \
    --data-binary "@${TMPDIR:-/tmp}/smoke-3mb.json" "$BASE/api/healthz"
  local result=$?
  rm -f "${TMPDIR:-/tmp}/smoke-3mb.json"
  return $result
}

api_down_problem() {
  local status
  for status in 502 503 504; do
    edge_problem "$status" SERVICE_UNAVAILABLE 'Service unavailable' "$BASE/api/healthz" && return 0
  done
  return 1
}

# A one-time token in a URL must never reach the edge's access log, even from a legacy
# ?token= link (links carry it in the fragment, which browsers never send). The request
# must still be logged, with the query masked, so the check isn't vacuous.
token_not_logged() {
  local token
  token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  curl -s -o /dev/null --max-time 5 "$BASE/reset-password?token=${token}"
  curl -s -o /dev/null --max-time 5 -H "Referer: $BASE/reset-password?next=%2F&token=${token}" "$BASE/"
  sleep 1
  local logs
  logs="$(docker compose logs --no-color web)"
  if grep -q -- "$token" <<<"$logs"; then
    echo "the token appears in the web access log" >&2
    return 1
  fi
  grep -q 'GET /reset-password?\[redacted\]' <<<"$logs"
}

echo "smoke: checking the compose stack on ${BASE}"

eventually "migrate exited 0" migrate_ok
for service in db api web maintenance mailpit; do
  eventually "${service} is running and healthy" service_ok "$service"
done

eventually "GET /api/healthz through web" body_contains "$BASE/api/healthz" '"status":"ok"'
eventually "GET /api/readyz through web" body_contains "$BASE/api/readyz" '"status":"ready"'
eventually "GET / serves the app's HTML" serves_html
eventually "GET /metrics through web is 404" status_is "$BASE/metrics" 404
eventually "no host-published port serves Prometheus content" no_published_port_serves_metrics
eventually "api:9464/metrics answers inside the network" internal_metrics
eventually "maintenance logged its first purge run" maintenance_ran
eventually "Mailpit API answers on 127.0.0.1:8025" body_contains "http://127.0.0.1:8025/api/v1/info" '"Version"'
# SC-001's start time is measured here, before the checks below restart the API.
ready_at="$(date +%s)"
eventually "the api's mail reaches Mailpit over SMTP" api_mail_reaches_mailpit
eventually "a 3 MB POST gets the edge's problem+json 413" oversized_post
eventually "a token in a URL or Referer never reaches the web access log" token_not_logged

# Last, because it stops the API: the edge's own 502/504 is problem+json too. The API is
# started again and must become healthy before the script ends.
docker compose stop api >/dev/null 2>&1
eventually "with the API down the edge answers problem+json SERVICE_UNAVAILABLE" api_down_problem
docker compose start api >/dev/null 2>&1
eventually "api is healthy again after the restart" service_ok api

started="${SMOKE_STARTED_AT:-}"
if [[ -z "$started" ]]; then
  db_id="$(docker compose ps -q db 2>/dev/null || true)"
  if [[ -n "$db_id" ]]; then
    started="$(date -d "$(docker inspect --format '{{.State.StartedAt}}' "$db_id")" +%s)"
  fi
fi
if [[ -n "$started" ]]; then
  echo "smoke: stack ready $((ready_at - started))s after start (SC-001 budget: 600s)"
else
  echo "smoke: start time unknown (no db container)"
fi

if ((failures > 0)); then
  echo "smoke: ${failures} check(s) failed" >&2
  exit 1
fi
echo "smoke: all checks passed"
