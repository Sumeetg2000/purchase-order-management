# ADR-0020: Technology stack, operations, security baseline and data retention

- **Status:** Accepted · 2026-10-20 (moved here from the constitution, plus the retention
  rules and the `maintenance` compose service) · amended 2026-10-23 (internal-only metrics
  port; public-repository CI rules and secret scanning; credential separation)
- **Brief:** stack, §6 ("`docker compose up` and a documented `.env` only")
- **Principles:** IX, XII

## Decision

### Stack
- **API**: Node.js (active LTS) + TypeScript, Express and Prisma, with raw SQL in migrations
  for triggers, generated columns, privileges and partial indexes. PostgreSQL 16+.
- **Frontend**: React (Vite), React Router, TanStack Query (ADR-0018).
- **Contract**: Zod with zod-openapi, and openapi-typescript (ADR-0008).
- **Tests**: Vitest + Supertest + Testcontainers, fast-check, Testing Library, MSW,
  Playwright and axe.
- **Tooling**: k6 or autocannon, and oasdiff.
- **Runtime**: nginx (same-origin edge), docker compose, an SMTP relay (Mailpit in
  compose, ADR-0017), and the `maintenance` service (below).
- One API service, one PostgreSQL database, one React app, the nginx edge and the
  `maintenance` service. A new runtime dependency or service requires an ADR.

### Startup and configuration
- `docker compose up`:
  1. starts the database
  2. applies migrations
  3. runs the admin bootstrap (ADR-0016)
  4. seeds the single-tier approval policy (ADR-0002). This is reference data, seeded in
     every environment.
  5. seeds demo Buyers and one demo Approver **only when `SEED_DEMO_DATA=true`**
  6. starts the API, the web app and the `maintenance` service, plus Mailpit under the
     `local` profile (ADR-0017)
- **Local vs deployment**: `.env.example` is the local setup, with
  `COMPOSE_PROFILES=local`, `SEED_DEMO_DATA=true` and SMTP pointing at Mailpit. A
  deployment's `.env` sets `APP_ENV=production`. Config validation then **refuses**
  `SEED_DEMO_DATA=true` and an SMTP host of `mailpit`, so demo accounts with known
  passwords can never exist in a deployment.
- Every variable is documented in `.env.example`, including `SIGNUP_ALLOWED_DOMAINS`, the
  SMTP settings, `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_NAME` and the rate-limit store.
- Config is validated by schema at startup, and the process exits non-zero if it's
  invalid.
- Graceful shutdown drains in-flight requests and closes the pool.

### Security baseline
- Helmet security headers, CORS denied by default (same origin, ADR-0017), and request
  body size limits.
- Parameterized SQL only.
- No secrets in the repository or images. Containers run as non-root.
- Dependency scanning with no unresolved high or critical findings.
- **Public repository**:
  - CI runs on `pull_request` and `push` only, never `pull_request_target`, with read-only
    permissions.
  - Secrets come only from GitHub Actions secrets, and no check needs one, so pull requests
    from forks pass using generated throwaway values.
  - `.env.example` holds placeholders only.
  - gitleaks scans every pull request's diff and the full history on `main`, as a required
    check.
- Least-privilege database roles (ADR-0003):
  - owner (migrations)
  - app (runtime)
  - maintenance (retention purges)

### Observability
- Structured JSON logs (pino) with a correlation id on every line. The id is also
  returned as a response header and stored in audit entries.
- No secrets, tokens or phone numbers are logged. The only exceptions are the bootstrap and
  `admin:create` set-password links (ADR-0016).
- `/healthz` checks liveness and `/readyz` checks the database.
- **Metrics**: request latency and error rates are exposed in Prometheus format at
  `/metrics`, on a separate internal-only API port.
  - Docker compose declares that port with `expose` only, so it's reachable inside the
    compose network and never published to the host with `ports`.
  - nginx never routes `/metrics`, and returns `404` for it.
  - No metrics server is bundled. A deployment that wants one scrapes the internal port.
- Security events go to a separate `security` log stream (ADR-0017).

### Data safety
- All timestamps are `timestamptz` UTC. Business dates that depend on the calendar (the
  PO number's financial year) are computed in `Asia/Kolkata` (ADR-0001).
- Vendors and users are deactivated, never deleted.
- Prisma migrations are versioned, reviewed and forward-only.

### Retention
| Data | Kept for | Basis |
|---|---|---|
| Business audit entries (including actor name and email snapshots) | 8 years | Companies Act 2013 s.128(5); DPDP Act 2023 legal-obligation basis (ADR-0016) |
| Orders, lines, receipts, vendors, users (name, email), access requests | Not purged (users are deactivated, never deleted) | Statutory books and the audit record |
| User phone | Cleared 90 days after deactivation; not restored on reactivation | DPDP: no purpose once the person has left (ADR-0016) |
| Session rows and refresh tokens (IP, user agent) | 90 days after the session ends | DPDP: only as long as needed for security (ADR-0017) |
| Security log entries | 90 days | Same |
| One-time tokens | Deleted 7 days after use or expiry | No longer needed |
| Idempotency keys | 24 hours (ADR-0006) | — |

- **Purge job**: `npm run maintenance -- purge` connects as the **maintenance role**. Only
  that role has `DELETE` on audit, sessions, refresh tokens, one-time tokens and
  idempotency keys, and `UPDATE` on the `phone` column of users (to clear it). It also has
  `INSERT` on audit for `USER_PHONE_PURGED`. The app role never deletes any of them.
  - Each run deletes only rows past their limit, in batches, and logs the counts.
  - Each run takes a PostgreSQL advisory lock (`pg_try_advisory_lock`). If another run
    holds it, the new run logs "already running" and exits as a no-op.
  - It logs one structured line per table with the number of rows deleted.
- Security-log retention is set in the log store's configuration and documented in
  `.env.example`.

### `maintenance` compose service
Docker compose **is** the deployment, so the purge runs there. Per Principle XII, a new
runtime service needs an ADR, and this section is it.
- It uses the same image as the API, with its own command: a simple loop that runs
  `npm run maintenance -- purge` once a day, the first run at start, then sleeps 24 h.
  No in-container cron, so there is no extra daemon.
- It connects with the **maintenance role's credentials** (`MAINTENANCE_DATABASE_URL`).
  The API service never receives them, and the API's config schema rejects them if they're
  present.
- It has no published ports, no HTTP surface, and restarts with `unless-stopped`.
- It starts after migrations have run. A failed run logs an error, and the loop continues
  to the next day.
- Alternatives: running the purge inside the API process (it would need the maintenance
  credentials, which defeats the role split); host cron (outside `docker compose up`, so
  not reproducible from `.env` alone). Both rejected.

## Tests
- Invalid config exits non-zero. With `APP_ENV=production`, `SEED_DEMO_DATA=true` or an
  SMTP host of `mailpit` → exits non-zero.
- Readiness fails when the database is down.
- `/metrics` through nginx → 404. No host-published port serves it. The internal port
  serves it inside the compose network.
- Security headers are present. A cross-origin request is denied.
- The purge (called directly) removes only expired rows of each kind, and runs only as the
  maintenance role. The app role's `DELETE` on audit is denied.
- The phone purge clears only phones of users deactivated more than 90 days ago, and
  audits each one without the number.
- A second purge started while one holds the advisory lock is a no-op. Per-table counts
  are logged.
- The API's config validation rejects maintenance credentials.
- The compose smoke test: `up` → health → login → order flow, and the `maintenance` service
  is running and has logged its first run.
