# Quickstart: Validating Slice 0 — Foundation

Run these steps to prove the slice works end to end. Each step names the spec story it
proves. The commands below are the planned script names from the root `package.json`. They are
copied into `CLAUDE.md` once they exist.

## Prerequisites

- Docker with Compose v2
- Node.js 24 and npm, for running tests outside containers
- A clean checkout of branch `001-foundation`

## 1. Start the stack (Story 1)

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps            # migrate: exited (0); db, api, web, maintenance, mailpit: healthy/running
```

Expected:
- `curl -s localhost:8080/api/healthz` → `{"status":"ok"}`
- `curl -s localhost:8080/api/readyz` → `{"status":"ready","checks":{"database":"ok","migrations":"ok"}}`
- `http://localhost:8080` shows the app shell.
- `http://127.0.0.1:8025` shows the Mailpit inbox.
- `curl -si localhost:8080/metrics` → `404`
- `docker compose exec web wget -qO- http://api:9464/metrics | grep po_http_requests_total` →
  a match

Readiness fails without the database:
```bash
docker compose stop db
curl -si localhost:8080/api/readyz    # 503, problem+json, code SERVICE_UNAVAILABLE
curl -si localhost:8080/api/healthz   # 200
docker compose start db
```

## 2. First admin (Story 5)

```bash
docker compose logs migrate | grep -A2 "One-time set-password link"   # exactly one link
docker compose up -d --force-recreate migrate && docker compose logs migrate | grep -c "set-password link"
# still 1 in the new run's output: nothing is created or printed again
docker compose exec api npm run admin -- admin:create --email second@example.local --name "Second Admin"
# prints a link, exit 0
docker compose exec api npm run admin -- admin:create --email second@example.local --name "Again"
# ERROR EMAIL_IN_USE …, exit 2
```

## 3. Errors and correlation (Story 3)

```bash
curl -si -X POST localhost:8080/api/healthz -H 'content-type: application/json' -d '{}'
# 404 NOT_FOUND (method not defined), problem+json with correlationId
curl -si localhost:8080/api/nope -H 'X-Request-Id: demo-req-0001'
# 404, header X-Request-Id: demo-req-0001, body correlationId demo-req-0001
docker compose logs api | grep demo-req-0001        # every line for that request carries it
curl -si localhost:8080/api/healthz -H 'Origin: https://evil.example'   # 403 CSRF_REJECTED
```

Slice 0 has no endpoint that takes a body. Malformed JSON, the wrong content type,
unknown fields, an oversized body, an internal failure and `503` are therefore proven by
the API integration tests, using routes registered only in the test app
(`npm test -w apps/api -- errors`).

## 4. Configuration refusals (Story 1)

```bash
APP_ENV=production SEED_DEMO_DATA=true docker compose run --rm migrate   # exits 1, names SEED_DEMO_DATA
APP_ENV=production docker compose run --rm api                           # exits 1, names SMTP_HOST (mailpit)
```

## 5. Developer inner loop (optional, research R25)

```bash
npm ci
npm run dev        # db, migrate and Mailpit from compose; API with reload; web with HMR on :8080
```

Expected:
- `http://localhost:8080` serves the app with hot reload, and `/api/healthz` is proxied to
  the host-run API, on the same origin as production.
- Editing `apps/api/src/**` restarts the API in about a second. Editing `apps/web/src/**`
  updates the page without a reload.
- The response headers match production's CSP. The only addition is the dev-only nonce
  for the React Refresh preamble.
- `npm test` needs only Docker: it starts its own PostgreSQL via Testcontainers.

## 6. Automated checks (Story 2)

```bash
npm ci                         # if not already done in step 5
npm run lint && npm run typecheck && npm run check:ids
npm test                       # API (real PostgreSQL via Testcontainers) + web
npm run contract:generate && git diff --exit-code packages/contracts/openapi
npm run build -w apps/web && npm run check:bundle
npm run e2e                    # Playwright, Chromium, against the running stack
npm run check:traceability
```

Each check must fail when its target is broken. The spec's Story 2 scenarios are
reproduced as CI self-tests.

## 7. Audit guarantees (Story 4)

These are covered by the API integration suite (`npm test -w apps/api -- audit`):
- an audited change without actor context is refused
- `UPDATE` or `DELETE` on `audit_entries` as `po_app` → permission denied
- mismatched actor fields are refused
- a rolled-back transaction leaves no entry
- the privilege snapshot matches the expected list for all three roles

## 8. Mail and purge (Stories 7, 8)

- `npm test -w apps/api -- mail`: send-after-commit, nothing on rollback, failure logged.
- `npm test -w apps/api -- purge`: only expired audit entries and tokens removed; a second
  concurrent run is a no-op.
- `docker compose logs maintenance` shows the first run with per-table counts.

## Done

Every command above behaves as stated, CI is green on the pull request, and the
traceability rows the slice delivers fully are `Done`.
