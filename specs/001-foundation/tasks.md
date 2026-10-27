---

description: "Task list for Slice 0 — Foundation"
---

# Tasks: Slice 0 — Foundation

**Input**: Design documents from `specs/001-foundation/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Required. Principle VIII says tests come first. Every test task must be **run and
seen failing** before the implementation task that makes it pass. Record the failing run's
output summary in the commit message body of the test task.

**Organization**: Setup, then Foundational, then one phase per user story, then Polish.
Within P1, US2 runs last: its contract and traceability checks need US3's registry and
US4's schema to check against. Every P1 story still finishes before any P2 story starts.

## Format: `- [ ] T### [P?] [US#?] Outcome — files — refs — Verify`

- **[P]**: can run in parallel with the other [P] tasks of the same group (different files,
  no dependency on an incomplete task).
- **[US#]**: user story from spec.md. Setup, Foundational and Polish tasks have none.
- **Refs**: spec FR/SC IDs, and the `docs/traceability.md` row where it helps.
- **Size**: each task is one reviewable commit, roughly under 300 changed lines.
- **Commits**: Conventional Commits. Requirement IDs (`FR-ADM-04`) go only in test names,
  never in commit subjects or code (ADR-0013).
- **Commit and push policy**:
  - A test task's commit (tests seen failing) may be pushed, and CI shows it red.
  - The implementation commits that follow turn it green.
  - Each story's **checkpoint commit**, which is the review task at the end of the phase,
    must leave every CI job on the draft PR green before the next story starts.
- **Reviews**: every story ends with `/code-review`. US1, US3, US4 and US5 also get
  `/security-review`. All findings are fixed before the next story starts. T116's full
  review of the whole PR still happens at the end.

## Path conventions

- `backend/`: API, migrate, bootstrap, CLI, maintenance
- `frontend/`: React app
- `packages/contracts/`: Zod schemas, error registry, OpenAPI generator
- `deploy/`, `scripts/`, `.github/workflows/`: deployment, check scripts, CI

---

## Phase 1: Setup (shared infrastructure)

**Purpose**: the repository is safe to work in, and every later commit lands under
lint, typecheck and the secret scan.

- [X] T001 Add the root ignore rules **before any `.env` exists** — `.gitignore`. Cover
  `.env`, `.env.*` with `!.env.example`, `node_modules/`, `dist/`, `build/`, `coverage/`,
  `playwright-report/`, `test-results/`, `reports/`, `*.tsbuildinfo`, `.vite/` and
  `.DS_Store` (research R24) — FR-001 — Verify: `printf '.env\n.env.local\nnode_modules/x\ndist/x\ncoverage/x\nbuild/x\n' | git check-ignore --stdin` lists all six lines, and `git check-ignore .env.example` prints nothing.
- [X] T002 Root npm workspace — `package.json` (workspaces `packages/*`, `backend`, `frontend`;
  engines node 24; scripts `lint`, `format:check`, `typecheck` and `test` as stubs),
  `.nvmrc` (`24`), `.npmrc` (`engine-strict=true`, `save-exact=true`),
  `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), `package-lock.json` — FR-038 — Verify: `npm ci` succeeds
  on Node 24.
- [X] T003 [P] Contracts package skeleton — `packages/contracts/package.json`,
  `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts` (Zod 4
  dependency) — FR-020 — Verify: `npm run typecheck -w packages/contracts`.
- [X] T004 [P] API package skeleton:
  - `backend/package.json`:
    - `dependencies`: Express 5, `@prisma/client`, **`prisma` (the CLI)**, pino, Zod 4. The
      CLI must be a runtime dependency, because `migrate` runs `prisma migrate deploy` in
      the `--omit=dev` image.
    - `devDependencies`: tsx, which is used only by the dev loop, never by scripts the
      images run.
    - scripts `build`, `start` (`node dist/server.js`), `typecheck`, and
      `admin` (`node dist/cli/admin.js`, never tsx)
  - `backend/tsconfig.json`
  - `backend/src/server.ts` (starts an empty Express app on `HTTP_PORT`)
  - `backend/src/cli/admin.ts` (a stub runner: `--help` prints usage and exits 0, and any
    other command exits 1 with `ERROR USAGE`; T082 adds the commands)

  — FR-002, FR-033 — Verify: `npm run build -w backend && npm run typecheck -w backend`,
  and `npm run admin -w backend -- --help` exits 0.
- [X] T005 [P] Web package skeleton — `frontend/package.json` (React 19, Vite, TypeScript),
  `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`,
  `frontend/src/main.tsx`, `frontend/src/App.tsx`, and `browserslist` in
  `frontend/package.json` (`last 2 Chrome versions, last 2 Edge versions, last 2 Firefox
  versions, last 2 Safari versions`, research R22). Vite doesn't read `browserslist`, so
  `vite.config.ts` sets `build.target` from it with `browserslist-to-esbuild` — FR-041 —
  Verify: `npm run build -w frontend` succeeds, and a unit test
  (`frontend/tests/build-target.test.ts`) asserts that the resolved `build.target` equals
  the targets derived from `browserslist`.
- [X] T006 Lint and format — `eslint.config.mjs` (typescript-eslint strict-type-checked,
  react-hooks, a ban on `dangerouslySetInnerHTML` (done with the core `no-restricted-syntax`
  rule, because `eslint-plugin-react`'s `react/no-danger` doesn't support ESLint 10 yet), no `any`, no non-null
  assertion, `no-restricted-syntax` placeholder for later rules), `.prettierrc`, `.prettierignore`, root scripts `lint`, `format:check` and
  `typecheck` (all workspaces) — FR-038 — Verify: `npm run lint && npm run format:check &&
  npm run typecheck` pass. Scratch violations fail lint: a file with `any`, and a component
  using `dangerouslySetInnerHTML` (FR-027).
- [X] T007 Test runner — a `vitest.config.ts` in each package (web merges `vite.config.ts`),
  each with the JSON reporter writing to `reports/vitest-<package>.json`; one trivial
  passing test in `packages/contracts/tests/` and `backend/tests/` (web already has
  `build-target.test.ts`); package `test` scripts, and a root `test` that runs every
  workspace. The tsconfig is split per package: `tsconfig.build.json` emits `src/` only,
  and `tsconfig.json` (no emit) covers `src/`, `tests/` and configs for typecheck, lint and
  tests. Vitest 5 has no `vitest.workspace.ts`, and per-package configs keep `npm test -w`
  self-contained — FR-038 — Verify: `npm test` passes and writes three JSON reports.
- [X] T008 CI skeleton for a public repository — `.github/workflows/ci.yml`:
  - triggers `pull_request` (to `main`) and `push` (to `main`) **only**, never
    `pull_request_target`
  - `permissions: contents: read` and `concurrency` per ref
  - job `static`: `npm ci`, actionlint, lint, format check, typecheck
  - job `secrets`: gitleaks from its pinned container image with `.gitleaks.toml`; the PR's
    commit range on `pull_request`, full history on `push` to `main`. The checkout uses
    `fetch-depth: 0`, because the commit range and the full history both need complete git
    history.

  Also `.gitleaks.toml` (default rules, no allowlist for real-looking values) — FR-038,
  SC-004 — Verify: `actionlint` passes locally, and `docker run --rm -v
  "$PWD:/repo" ghcr.io/gitleaks/gitleaks:<pinned> git /repo` exits 0. Both jobs then run and
  pass on the draft PR (T009).
- [X] T009 Open a **draft** PR `001-foundation → main`, titled "Slice 0 — Foundation"
  and linking `specs/001-foundation/spec.md`. The workflow triggers only on PRs to `main`
  and pushes to `main`, so from here on every push to the branch runs CI on this PR —
  FR-038 — Verify: `gh pr view --json isDraft,headRefName,baseRefName` shows
  `isDraft: true` and `001-foundation → main`, and the PR's checks show `static` and
  `secrets` green.
- [X] T010 [P] Commit message check — `commitlint.config.mjs` (conventional config), dev
  dependency `@commitlint/cli`, step in `static` that runs on `pull_request` over the PR's
  commits (`--from ${{ github.event.pull_request.base.sha }} --to ${{
  github.event.pull_request.head.sha }}`; the `static` checkout uses `fetch-depth: 0`) — FR-038 — Verify: `echo "bad message" | npx commitlint` fails, and
  `echo "chore: ok" | npx commitlint` passes.
- [X] T011 [P] Example environment and CI env generator — `.env.example` (every variable
  in [contracts/config.md](contracts/config.md); secrets as `change-me-…` placeholders;
  `COMPOSE_PROFILES=local`, `APP_ENV=local`, `SEED_DEMO_DATA=true`),
  `scripts/ci-env.sh` (copies to `.env`, replaces every `change-me-…` value with
  `openssl rand -hex 24`) — FR-007, FR-038 — Verify: `scripts/ci-env.sh && ! grep -qE
  '^[A-Z0-9_]+=change-me-' .env` (the header comment mentions the prefix, but no value
  keeps it); the script refuses to overwrite an existing `.env` without `--force`; and the `secrets` job stays green with `.env.example` committed.

**Checkpoint**: lint, typecheck and the secret scan guard every following commit.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: config loading, logging base, database roles and migrations, the test
database harness, route registration and the transaction helper. Every story needs them.

- [X] T012 Tests for the config loader, seen failing — `backend/tests/unit/config-load.test.ts`:
  - an invalid or missing key exits `1`, naming the key and the reason
  - a value whose key contains `PASSWORD`, `SECRET`, `TOKEN`, `URL` or `KEY` never appears
    in the output

  — FR-003 — Verify: `npm test -w backend -- config-load` fails (module missing).
- [X] T013 Config loader and base logger — `backend/src/config/load.ts` (Zod parse →
  formatted key list → `process.exit(1)`), `backend/src/observability/logger.ts` (pino
  JSON to stdout, level from `LOG_LEVEL`) — FR-003 — Verify: T012 passes.
- [X] T014 Database role provisioning and baseline migration:
  - `backend/db-init/roles.sql`: idempotent `po_owner`, `po_app`, `po_maintenance`, all
    `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`; `po_owner` owns the database and
    schema; `REVOKE ALL ON SCHEMA public FROM PUBLIC`
  - `backend/prisma/schema.prisma` (datasource only)
  - `backend/prisma/migrations/0001_baseline/migration.sql`: schema usage grants to
    `po_app` and `po_maintenance`, plus `GRANT SELECT ON _prisma_migrations TO po_app`
    (readiness reads it, T028). Nothing else.
  - `backend/src/migrate/run.ts`: step 1 db-init as superuser, step 2
    `prisma migrate deploy` as `po_owner`

  — FR-016 — Verify: `docker run -d postgres:17…` then `node dist/migrate/run.js` twice
  against it; the second run is a no-op.
- [X] T015 Test database harness — `backend/tests/support/db.ts`:
  - start Testcontainers PostgreSQL 17 once per run
  - run T014's provisioning
  - create a migrated template database
  - give each test a fresh `CREATE DATABASE … TEMPLATE` clone and connections as
    `po_app`, `po_maintenance` and `po_owner`

  Also `backend/tests/support/setup.ts`, plus a sanity test
  `backend/tests/integration/harness.test.ts` (`po_app` connects; `CREATE TABLE` as
  `po_app` → permission denied) — FR-016, FR-038 — Verify:
  `npm test -w backend -- harness` passes with only Docker running.
- [X] T016 [P] Tests for route registration and transactions, seen failing:
  - `backend/tests/unit/define-route.test.ts`: a route without `access` makes app
    startup throw; a route not in the OpenAPI registry throws; `access: 'public'` routes
    register
  - `backend/tests/integration/transaction.test.ts`:
    - the actor context settings are visible inside the transaction and gone after commit
      or rollback, and don't leak to the next transaction on the same pooled connection
    - `40001` is retried up to 3 times, then fails `CONCURRENCY_RETRY_EXHAUSTED`
    - `afterCommit` callbacks run once after commit, and never after rollback
    - pool exhaustion maps to `SERVICE_UNAVAILABLE` in both forms: a query outside a
      transaction (pg-pool's bare `Error`) and a transaction past `maxWait` (`P2028`)
    - a transaction past its `timeout` (`P2028`) maps to `SERVICE_UNAVAILABLE`
  - `backend/tests/integration/db-error-shapes.test.ts`: the probe's findings as a
    regression test, pinned to the locked Prisma, adapter and `pg` versions (research R5).
    It covers the pg-pool timeout message; `P2028` for `maxWait` and `timeout`; `P2010`
    with `TransactionWriteConflict` and `originalCode` for `40001` and `40P01`; `P2010`
    with `DatabaseNotReachable`; and a custom SQLSTATE `PO001` arriving as
    `cause.originalCode`. An upgrade that changes any shape fails here.

  — FR-015, FR-011, FR-030 — Verify: all three files fail (modules missing).
- [X] T017 Route registration and app factory — `backend/src/http/define-route.ts`
  (method, path, `access`, request and response Zod schemas, handler; registers OpenAPI
  metadata; startup check), `backend/src/http/app.ts` (`createApp({ routes, config })`),
  `backend/src/server.ts` (uses the factory) — FR-015 — Verify: `define-route.test.ts`
  passes.
- [X] T018 Transaction helper — `backend/src/db/client.ts` (Prisma client, explicit pool
  size), `backend/src/db/transaction.ts` (`withTransaction(ctx, fn)`:
  `set_config(..., true)` actor settings, `timeout` and `maxWait` from config, retries of
  `40001`/`40P01` with jitter (3), `afterCommit` queue), and the first version of
  `backend/src/db/errors.ts`:
  - `isPoolTimeout` (the pg-pool message match, the only one allowed)
  - `P2028` → `SERVICE_UNAVAILABLE`
  - `DatabaseNotReachable`, and raw Node connection errors (`ECONNREFUSED` and similar, as
    seen on the CI runner) → `SERVICE_UNAVAILABLE`
  - `TransactionWriteConflict` / `40001` / `40P01` / `P2034` → retryable, then
    `CONCURRENCY_RETRY_EXHAUSTED`

  T047 extends it with constraint and trigger codes — FR-011, FR-018 base, FR-030 base —
  Verify: `transaction.test.ts` and `db-error-shapes.test.ts` pass.
- [X] T019 CI test job — `.github/workflows/ci.yml`: job `api` (`npm ci`, `npm test -w
  backend` with Docker for Testcontainers, upload `reports/` as an artifact) — FR-038 —
  Verify: after the push, the draft PR's checks show `api` green alongside `static` and
  `secrets`.

**Checkpoint**: stories can start. The database, transactions and routes are tested
against real PostgreSQL in CI.

---

## Phase 3: User Story 1 — One-command start for an operator (Priority: P1) 🎯 MVP

**Goal**: `cp .env.example .env && docker compose up` starts db, migrate, api, web,
maintenance and Mailpit, with health, readiness, validated config, credential separation,
graceful shutdown and internal-only metrics.

**Independent Test**: from a clean checkout, the stack becomes healthy. Readiness fails
with the database stopped. Bad config is refused. `/metrics` is internal only.

### Tests for User Story 1 (write first, run, see them fail)

- [X] T020 [P] [US1] Config rule tests — `backend/tests/unit/config-rules.test.ts`.
  Cover every rule in [contracts/config.md](contracts/config.md):
  - production refuses `SEED_DEMO_DATA=true`, `SMTP_HOST=mailpit` and any `change-me-`
    secret
  - credential separation: one case per forbidden variable for api/cli and for
    maintenance; a `DATABASE_URL` user other than `po_app`; a maintenance URL user other
    than `po_maintenance`; migrate given `MAINTENANCE_DATABASE_URL`
  - `METRICS_PORT == HTTP_PORT` refused
  - every key read by any process schema appears in `.env.example`, either as a
    `KEY=value` line or on its `# composed:` comment line (the three database URLs that
    `docker-compose.yml` builds from the passwords); and `.env.example` has no key that no
    schema reads (FR-007)

  Test names cite `NFR-OPS-02` — FR-003, FR-004, FR-007 — Verify: `npm test -w backend --
  config-rules` fails.
- [X] T021 [P] [US1] Health and readiness tests — `backend/tests/integration/health.test.ts`:
  - `/healthz` → `200 {status:"ok"}`
  - `/readyz` → `200` with `database` and `migrations` both `ok`
  - with the database stopped, `/readyz` → `503 SERVICE_UNAVAILABLE` and `/healthz` → `200`
  - with a pending migration, `/readyz` → `503`

  — FR-005 — Verify: fails.
- [X] T022 [P] [US1] Graceful shutdown test — `backend/tests/integration/shutdown.test.ts`
  (an in-flight slow request completes after `SIGTERM`, new connections are refused, and
  the pool is closed before exit) — FR-006 — Verify: fails.
- [X] T023 [P] [US1] Metrics listener test — `backend/tests/integration/metrics.test.ts`:
  - `/metrics` on `METRICS_PORT` returns Prometheus text with `po_http_requests_total`
  - the main port returns `404` for `/metrics`
  - labels use route patterns, never raw paths

  — FR-040 — Verify: fails.
- [X] T024 [P] [US1] Compose file test — `scripts/tests/compose.test.mjs`. It parses
  `docker-compose.yml` and asserts:
  - only `web` publishes `ports`; Mailpit publishes `127.0.0.1:8025` only, under the
    `local` profile
  - `api` uses `expose: ["9464"]`, never `ports`
  - `api`, `maintenance` and `migrate` have explicit `environment:` lists with only their
    allowed variables (contracts/config.md), and no `env_file`. `migrate` includes
    `DATABASE_URL`, and never `MAINTENANCE_DATABASE_URL`.
  - `api` and `maintenance` wait for `migrate` to complete successfully

  — FR-002, FR-004, FR-031, FR-040 — Verify: `node --test scripts/tests/compose.test.mjs`
  fails (no compose file).
- [X] T025 [US1] Smoke script, a test that fails until the stack exists — `scripts/smoke.sh`.
  It checks:
  - `migrate` exited 0, and `db`, `api`, `web`, `maintenance` and `mailpit` are healthy or
    running
  - `/api/healthz` and `/api/readyz` through `web`
  - `/` serves HTML
  - `GET /metrics` through `web` → `404`, and no host-published port (Mailpit's UI
    included) returns a body containing Prometheus content (`po_http_`), whatever its
    status
  - `docker compose exec web wget -qO- http://api:9464/metrics` contains
    `po_http_requests_total`
  - Mailpit's API answers on `127.0.0.1:8025`

  It prints the elapsed start time (SC-001) — FR-002, FR-040, SC-001 — Verify:
  `scripts/smoke.sh` fails now.
- [X] T026 [US1] Traceability: NFR-OPS-01, NFR-OPS-03 → `Tested` — `docs/traceability.md` —
  Verify: the status column shows `Tested`, and the test names above carry the IDs.

### Implementation for User Story 1

- [X] T027 [US1] Config schemas per process — `backend/src/config/{api.ts,cli.ts,migrate.ts,maintenance.ts,rules.ts}`.
  Implement the variables, production refusals, `change-me-` refusal, credential
  separation and the port check from contracts/config.md — FR-003, FR-004 — Verify: T020
  passes.
- [X] T028 [US1] Health and readiness routes — `backend/src/http/routes/health.ts`
  (`access: 'public'`; readiness runs `SELECT 1` and checks `_prisma_migrations` has no
  pending or failed rows) — FR-005 — Verify: T021 passes.
- [X] T029 [US1] Graceful shutdown — `backend/src/server.ts`
  (`SIGTERM`/`SIGINT` → stop accepting, drain with a timeout, `$disconnect`, exit 0) —
  FR-006 — Verify: T022 passes.
- [X] T030 [US1] Metrics — `backend/src/observability/metrics.ts` (prom-client histogram
  `po_http_request_duration_seconds`, counters `po_http_requests_total` and
  `po_http_errors_total`, default metrics), a second listener on `METRICS_PORT` in
  `backend/src/server.ts`, and a request-timing middleware in
  `backend/src/http/middleware/metrics.ts` (see [contracts/metrics.md](contracts/metrics.md))
  — FR-040 — Verify: T023 passes.
- [X] T030a [US1] Root `.dockerignore` — `.dockerignore`. Both images build from the
  repository root, so the build context must exclude: `.env` and `.env.*` (keeping
  `.env.example`), `.git`, `node_modules` at every level, `dist`, `build`, `coverage`,
  `reports`, `playwright-report`, `test-results`, `*.tsbuildinfo`, `docs`, `specs`,
  `.specify` and `.claude` — FR-001, FR-002 — Verify: checked by T031's image checks.
- [X] T031 [P] [US1] API image — `deploy/api.Dockerfile` (multi-stage
  `node:24.x-alpine`, `npm ci --omit=dev` for runtime, non-root user, entrypoints for
  `dist/server.js`, `dist/migrate/run.js` and `dist/maintenance/loop.js`; the Prisma
  schema and migrations copied in) — FR-002 — Verify: `docker build -f
  deploy/api.Dockerfile .`, then against the built image:
  - `docker run --rm <img> id -u` isn't 0
  - `docker run --rm <img> npx --no-install prisma --version` prints the pinned version,
    so the CLI is present without dev dependencies
  - `docker run --rm <img> npm run admin -- --help` exits 0 and prints usage
  - the built image contains no `.env` file and no `.git` directory (T030a)
- [X] T032 [P] [US1] Web image and edge config — `deploy/web.Dockerfile` (build
  `frontend`, then `nginx:stable-alpine`, non-root), `deploy/nginx/default.conf` (serve
  the SPA with history fallback; `location /api/` → `http://api:3000/`;
  `location = /metrics { return 404; }`) — FR-002, FR-040 — Verify: `docker build -f
  deploy/web.Dockerfile .` succeeds.
- [X] T033 [US1] Maintenance loop skeleton — `backend/src/maintenance/loop.ts` (validates
  maintenance config, runs registered purge tasks at start and every
  `PURGE_INTERVAL_HOURS`; logs `purge run complete` with per-task counts, an empty map
  for now; a failed run logs an error and continues), `backend/src/maintenance/registry.ts`
  — FR-036 (skeleton) — Verify: `node dist/maintenance/loop.js` with a valid maintenance
  URL logs one `purge run complete` line.
- [X] T034 [US1] Compose stack — `docker-compose.yml`:
  - `db` (`postgres:17.x`, `pg_isready` health check, no host port)
  - `migrate` (one-shot `node dist/migrate/run.js`; `POSTGRES_PASSWORD`, the
    `DB_*_PASSWORD`s, `OWNER_DATABASE_URL`, and `DATABASE_URL` (`po_app`) for the bootstrap
    step; never `MAINTENANCE_DATABASE_URL`)
  - `api` (`DATABASE_URL` and the app variables only, `/healthz` health check with
    `wget`, `expose: ["9464"]`)
  - `web` (`ports: ["${WEB_PORT}:8080"]`)
  - `maintenance` (`MAINTENANCE_DATABASE_URL` only)
  - `mailpit` (`profiles: ["local"]`, `127.0.0.1:8025:8025`)

  — FR-002, FR-004, FR-031, FR-040 — Verify: T024 passes, and `scripts/ci-env.sh && docker
  compose up -d --wait && scripts/smoke.sh` passes (T025).
- [X] T035 [US1] CI end-to-end job — `.github/workflows/ci.yml`: job `e2e`
  (`scripts/ci-env.sh`, `docker compose up -d --build --wait`, `scripts/smoke.sh`, and
  `docker compose logs` on failure) — FR-038, SC-001 — Verify: the `e2e` job is green on the draft PR, and its log shows the start time.
- [X] T036 [US1] Traceability: NFR-OPS-03 → `Done`. NFR-OPS-01 stays `Tested` (partial):
  slice 0 proves up → health, login lands in slice 1, and slice 6's end-to-end order flow
  completes the row — `docs/traceability.md` —
  Verify: `scripts/check-traceability.mjs` (once T065 lands) shows them satisfied by
  passing tests. Until then, check the reports by hand.

- [X] T037 [US1] Story checkpoint review: run `/code-review` and `/security-review` over this story's
  commits, fix every finding (each fix in its own commit, with a test where the
  finding is a bug), and push. This is the checkpoint commit — Verify: no open
  findings remain, and every CI job on the draft PR is green on this commit.

**Checkpoint**: the stack starts with one command and is checked in CI.

---

## Phase 4: User Story 3 — Consistent, traceable failures (Priority: P1)

**Goal**: one problem format, one registry, correlation ids end to end, redacted logs,
`503` for overload, the same-origin guard and security headers on the API.

**Independent Test**: malformed, invalid, oversized, unknown-route, cross-origin and
failing requests each return the right code, with a correlation id matching the logs, and
nothing secret leaks.

### Tests for User Story 3 (write first, run, see them fail)

- [X] T038 [P] [US3] Registry tests — `packages/contracts/tests/errors.test.ts`:
  - codes are unique and `UPPER_SNAKE_CASE`
  - the slice 0 set is exactly the one in [contracts/errors.md](contracts/errors.md):
    `VALIDATION_FAILED` 400, `CSRF_REJECTED` 403, `NOT_FOUND` 404, `PAYLOAD_TOO_LARGE`
    413, `INTERNAL_ERROR` 500, `SERVICE_UNAVAILABLE` 503, `CONCURRENCY_RETRY_EXHAUSTED` 503
  - no status is 422

  — FR-008 — Verify: fails.
- [X] T039 [P] [US3] Error response tests, using test-only routes —
  `backend/tests/integration/errors.test.ts`:
  - malformed JSON → `400 VALIDATION_FAILED [{path:"body",code:"MALFORMED_JSON"}]`
  - a body without `application/json` → `UNSUPPORTED_MEDIA_TYPE`
  - an unknown field → `UNKNOWN_FIELD`
  - a non-UUID path id → `INVALID_FORMAT`
  - a body over 1 MB → `413 PAYLOAD_TOO_LARGE`, before parsing
  - an unknown route, and an undefined method on a known path → `404 NOT_FOUND`
  - a thrown plain `Error` → `500 INTERNAL_ERROR`, with no stack or message in the body
  - every body is `application/problem+json`, with `correlationId` equal to the
    `X-Request-Id` header
  - throwing an unregistered code fails at compile time and at runtime

  — FR-008, FR-009 — Verify: fails.
- [X] T040 [P] [US3] Correlation and redaction tests —
  `backend/tests/integration/logging.test.ts`:
  - a valid `X-Request-Id` is echoed; one that's invalid, over 36 characters or absent is
    replaced with a UUIDv7
  - every log line of a request carries the id
  - cookie, `authorization`, `set-cookie`, and nested `password`, `token`, `secret` and
    `phone` values are redacted
  - only the `oneTimeLink` logger path may print a token-shaped value

  Also `backend/tests/support/log-capture.ts` and `backend/tests/support/response-audit.ts`,
  each with a global `afterAll` that fails the run:
  - if any captured log line has a token-shaped value outside that path (SC-003)
  - if any error response seen by Supertest in the whole suite isn't
    `application/problem+json`, has a code outside the registry, or has a `correlationId`
    that doesn't match its `X-Request-Id` header and its log lines (SC-002)

  — FR-008, FR-012, FR-013, SC-002, SC-003 — Verify: fails.
- [X] T041 [P] [US3] Overload and database error tests —
  `backend/tests/integration/overload.test.ts`:
  - pool of size 1 held busy, then an HTTP request whose handler queries outside a
    transaction (pg-pool's bare `timeout exceeded when trying to connect`) → `503
    SERVICE_UNAVAILABLE`
  - the same with a handler using `withTransaction` (`P2028`, past `maxWait`) → `503
    SERVICE_UNAVAILABLE`
  - a transaction past its `timeout` (`P2028`) → `503`
  - retries exhausted → `503 CONCURRENCY_RETRY_EXHAUSTED`
  - database unreachable (`DatabaseNotReachable`) → `503`

  Also `backend/tests/unit/db-errors.test.ts`, using the error shapes recorded in research
  R5: `P2002` (by `cause.constraint.index`), `P2003`, `P2025`, `P2028`, the pg-pool
  timeout, `P2010` with `TransactionWriteConflict`, `DatabaseNotReachable`, and trigger
  SQLSTATEs `PO001`/`PO002` → `INTERNAL_ERROR` (logged) — FR-010, FR-011 — Verify: fails.
- [X] T042 [P] [US3] API security tests — `backend/tests/integration/security.test.ts`:
  - helmet headers on API responses
  - an `Origin` not equal to `APP_ORIGIN` → `403 CSRF_REJECTED`
  - no `Origin`, or the same origin → passes
  - the body limit applies

  — FR-014 — Verify: fails.
- [X] T043 [US3] Traceability: NFR-API-02, NFR-CON-02 → `Tested`; NFR-VAL-01,
  NFR-AUTH-01, NFR-PRIV-01 (partial) → `Tested` — `docs/traceability.md` — Verify: the
  statuses changed, and the IDs appear in T038–T042 test names.

### Implementation for User Story 3

- [X] T044 [US3] Error registry and problem schema —
  `packages/contracts/src/errors.ts` (registry entries with status, title and
  `fieldDetails`; `ErrorCode` type), `packages/contracts/src/schemas/problem.ts` (Zod
  `Problem`, `FieldError`), and the `AppError` class in `packages/contracts/src/app-error.ts`
  — FR-008 — Verify: T038 passes.
- [X] T045 [US3] Correlation id and redacting logger —
  `backend/src/http/middleware/correlation.ts` (validate `^[A-Za-z0-9._-]{8,36}$` or
  generate a UUIDv7; set the header; child logger; `ctx.requestId`), and the `redact`
  paths plus the `oneTimeLink` channel in `backend/src/observability/logger.ts`;
  pino-http wiring in `backend/src/http/app.ts` — FR-012, FR-013 — Verify: T040 passes.
- [X] T046 [US3] Error and parsing middleware — `backend/src/http/middleware/errors.ts`
  (problem+json renderer, not-found handler, `500` without detail),
  `backend/src/http/middleware/parse-json.ts` (content-type check, 1 MB limit → `413`,
  malformed → `MALFORMED_JSON`), and Zod → field-code mapping in
  `backend/src/http/define-route.ts` — FR-008, FR-009 — Verify: T039 passes, and after a
  `404`, `po_http_errors_total{code="NOT_FOUND"}` has increased (contracts/metrics.md; the
  renderer sets the problem code the metrics middleware counts).
- [X] T047 [US3] Central database error mapper — extends `backend/src/db/errors.ts`
  from T018 with constraint mapping (`P2002` by `cause.constraint.index`, `P2003`,
  `P2025`) and the trigger SQLSTATEs (`PO001`, `PO002` → `INTERNAL_ERROR`, logged); wiring
  into `withTransaction` and the error middleware; and an ESLint `no-restricted-syntax`
  rule in `eslint.config.mjs` that bans `.message` reads on caught errors outside
  `db/errors.ts` — FR-010, FR-011 — Verify: T041 passes, and a scratch violation fails
  `npm run lint`.
- [X] T048 [US3] API security middleware — `backend/src/http/middleware/security.ts`
  (helmet; origin guard → `CSRF_REJECTED`; `cors` disabled) — FR-014 — Verify: T042 passes.
- [X] T049 [US3] Traceability: NFR-API-02, NFR-CON-02 → `Done` — `docs/traceability.md`
  — Verify: T038–T042 green in the `api` job.

- [X] T050 [US3] Story checkpoint review: run `/code-review` and `/security-review` over this story's
  commits, fix every finding (each fix in its own commit, with a test where the
  finding is a bug), and push. This is the checkpoint commit — Verify: no open
  findings remain, and every CI job on the draft PR is green on this commit.

**Checkpoint**: every failure has one shape, one code and one traceable id.

---

## Phase 5: User Story 4 — The audit trail can't be bypassed (Priority: P1)

**Goal**: the database enforces actor context, append-only audit and least-privilege
roles.

**Independent Test**: as `po_app`, every bypass attempt is refused, and a rolled-back
transaction leaves no entry.

### Tests for User Story 4 (write first, run, see them fail)

- [X] T051 [P] [US4] Role and privilege snapshot test — `backend/tests/integration/roles.test.ts`:
  - all three roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`; `po_app` and
    `po_maintenance` own nothing
  - table grants equal the expected list in [data-model.md](data-model.md), including
    `po_app`'s `SELECT` on `_prisma_migrations`; `PUBLIC` has nothing
  - `po_app` can't `ALTER TABLE`, `DISABLE TRIGGER` or `SET session_replication_role`

  — FR-016, SC-005 — Verify: fails.
- [X] T052 [P] [US4] Audit enforcement tests — `backend/tests/integration/audit.test.ts`:
  - insert into `users` without actor context → `ACTOR_CONTEXT_REQUIRED`
  - `UPDATE` or `DELETE` on `audit_entries` as `po_app` → permission denied
  - `USER` without `actor_user_id` → refused; `OPERATOR` without `osUser`/`host` →
    refused; `SYSTEM` with an actor id → refused
  - explicit values that contradict the context → `ACTOR_CONTEXT_MISMATCH`
  - `request_id` and the actor fields are filled from the context
  - a rolled-back transaction leaves no entry

  Also `backend/tests/unit/audit-write.test.ts`: a typed slice 0 event (`ADMIN_CREATED`)
  type-checks, and an unknown event name or wrong `details` shape doesn't (`expectTypeOf`).
  Test names cite `NFR-AUD-02` — FR-017, FR-018, FR-019, SC-005 — Verify: fails.
- [X] T053 [US4] Traceability: NFR-AUD-02 → `Tested` — `docs/traceability.md`.

### Implementation for User Story 4

- [X] T054 [US4] Users table (minimal) — `backend/prisma/migrations/0002_users/migration.sql`
  and `schema.prisma`. Columns and checks:
  - `name` "1–100 characters (`CHECK`)"
  - `email` "stored lower-cased (`CHECK email = lower(email)`), `UNIQUE`"
  - `roles` `CHECK` "exactly one of `{}`, `{BUYER}`, `{APPROVER}`, `{BUYER,APPROVER}`,
    `{ADMIN}`"
  - `status` "`UNVERIFIED` | `ACTIVE` | `DEACTIVATED`"
  - "`CHECK (status = 'DEACTIVATED') = (deactivated_at IS NOT NULL)`"
  - `password_hash` nullable; `version` starts at 1

  Grants: `po_app` gets `SELECT, INSERT, UPDATE` (no `DELETE`) — FR-016, FR-032 base —
  Verify: the users part of T051 passes.
- [X] T055 [US4] Audit table, triggers and grants —
  `backend/prisma/migrations/0003_audit/migration.sql`:
  - `audit_entries` columns per data-model
  - the actor `CHECK` ("`USER`: `actor_user_id`, `actor_name`, `actor_email` and
    `acting_role` are not null; `SYSTEM`: all four are null; `OPERATOR`: `actor_user_id`
    is null, and `details ? 'osUser' AND details ? 'host'`")
  - index `(occurred_at, id)`
  - functions `require_actor_context()` and `audit_fill_actor()`, with their triggers
    (`users`: `require_actor_context`; `audit_entries`: `audit_fill_actor`)
  - grants: `po_app` gets `SELECT, INSERT`; `po_maintenance` gets
    `SELECT, DELETE, INSERT`

  — FR-017, FR-018, FR-019 — Verify: T051 and T052 pass.
- [X] T056 [US4] Typed audit writer — `backend/src/audit/events.ts` (event names and
  `details` types for slice 0: `ADMIN_CREATED`), `backend/src/audit/write.ts`
  (`writeAudit(tx, event)`, only inside `withTransaction`) — FR-017, FR-019 — Verify:
  T052's `audit-write.test.ts` passes.
- [X] T057 [US4] Traceability: NFR-AUD-02 → `Done` — `docs/traceability.md`.

- [X] T058 [US4] Story checkpoint review: run `/code-review` and `/security-review` over this story's
  commits, fix every finding (each fix in its own commit, with a test where the
  finding is a bug), and push. This is the checkpoint commit — Verify: no open
  findings remain, and every CI job on the draft PR is green on this commit.

**Checkpoint**: Principles I and IV have their database guarantees.

---

## Phase 6: User Story 2 — Every change is checked automatically (Priority: P1)

**Goal**: the contract pipeline, the ID ban, the traceability check, migrations from empty,
the dependency audit, all as CI jobs.

**Independent Test**: break each check in turn, and only that check fails (recorded in
T114).

### Tests for User Story 2 (write first, run, see them fail)

- [X] T059 [P] [US2] ID-ban script tests — `scripts/tests/check-requirement-ids.test.mjs`
  with fixtures in `scripts/tests/fixtures/ids/`:
  - an ID in source or a comment → fail
  - the same ID in `*.test.ts` → pass
  - an allowlisted false positive → pass
  - `docs/` and `specs/` are ignored

  — FR-038 — Verify: `node --test scripts/tests` fails.
- [X] T060 [P] [US2] Commit rule tests — `scripts/tests/commitlint-requirement-ids.test.mjs`
  (a subject with `NFR-OPS-01` → fail; the body → allowed) — FR-038 — Verify: fails.
- [X] T061 [P] [US2] Traceability script tests — `scripts/tests/check-traceability.test.mjs`
  with a fixture matrix and reports:
  - a test citing an unknown ID → fail
  - a `docs/BRIEF.md` section with no row → fail
  - `Tested` with no test → fail
  - `Done` with no passing test → fail
  - `Todo` and `Spec` → ignored (ADR-0013)

  — FR-039 — Verify: fails.
- [X] T062 [P] [US2] Contract tests — `packages/contracts/tests/openapi.test.ts` (the
  generated document has `getHealth` and `getReadiness`, `Problem`, and an `ErrorCode` enum
  equal to the registry; the output is deterministic) and
  `backend/tests/contract/responses.test.ts` (every response from T021 and T039 validates
  against `packages/contracts/openapi/openapi.json`) — FR-020, FR-022 — Verify: fail (no
  generator, no committed document).
- [X] T063 [P] [US2] Migrations-from-empty and reconciliation test —
  `backend/tests/integration/migrations.test.ts`:
  - all migrations apply to an empty database in order
  - `prisma migrate diff` between `schema.prisma` and the migrations is empty
  - `backend/src/db/reconciliation.sql` returns 0 rows

  — FR-038 — Verify: fails (no reconciliation file).
- [X] T064 [US2] Traceability: NFR-DEV-01, NFR-API-01 → `Tested` — `docs/traceability.md`.

### Implementation for User Story 2

- [X] T065 [US2] Traceability check — `scripts/check-traceability.mjs` (parses
  `docs/traceability.md`, `docs/BRIEF.md` §1–§8, and `reports/*.json` from Vitest and
  Playwright), root script `check:traceability` — FR-039 — Verify: T061 passes, and
  `npm run check:traceability` passes on the repo.
- [X] T066 [US2] ID ban — `scripts/check-requirement-ids.mjs`,
  `scripts/requirement-id-allowlist.txt`, root script `check:ids`, step in the `static` job
  — FR-038 — Verify: T059 passes, and `npm run check:ids` passes on the repo.
- [X] T067 [US2] Commit subject rule — `scripts/commitlint-plugin-requirement-ids.mjs`,
  registered in `commitlint.config.mjs` — FR-038 — Verify: T060 passes.
- [X] T068 [US2] OpenAPI generator and committed document — `packages/contracts/src/openapi.ts`
  (zod-openapi from `define-route` metadata and the registry; `servers: [{ url: '/api' }]`,
  the same prefix the web client uses), root script
  `contract:generate`, and `packages/contracts/openapi/openapi.json` (committed) —
  FR-020 — Verify: T062's contracts test passes, and a rerun leaves `git diff --exit-code`
  clean.
- [X] T069 [US2] Contract tests wired to the committed document —
  `backend/tests/support/openapi-validator.ts` (AJV against `openapi.json`) — FR-022 —
  Verify: T062's API contract test passes.
- [X] T070 [US2] Generated web client — `frontend/src/api/schema.d.ts` (openapi-typescript
  output, committed), `frontend/src/api/client.ts` (openapi-fetch, base `/api`, problem
  parsing), and script `contract:types`, with the drift check covering this file — FR-022
  — Verify: `npm run contract:types && git diff --exit-code frontend/src/api`.
- [X] T071 [US2] Reconciliation file — `backend/src/db/reconciliation.sql` (zero
  invariants yet, returns 0 rows; header comment says slice 3 adds INV-1–INV-6) — FR-038 —
  Verify: T063 passes.
- [X] T072 [US2] CI jobs:
  - `contract`: generate, `git diff --exit-code`, and `oasdiff breaking` against
    `origin/main`'s document. It fails unless the PR carries the `breaking` label, read from
    the event payload.
  - `audit`: `npm audit --audit-level=high`
  - `traceability`: `needs: [api, e2e]`; downloads the report artifacts, then runs
    `npm run check:traceability`
  - commitlint now uses the plugin

  — `.github/workflows/ci.yml` — FR-021, FR-038, FR-039 — Verify: all jobs green on the draft PR. A throwaway commit that removes a schema field
  turns `contract` red on the PR unless the `breaking` label is added; revert it afterwards.
- [X] T073 [US2] Traceability: NFR-DEV-01, NFR-API-01 → `Done` — `docs/traceability.md` —
  Verify: `npm run check:traceability` passes.

- [X] T074 [US2] Story checkpoint review: run `/code-review` over this story's
  commits, fix every finding (each fix in its own commit, with a test where the
  finding is a bug), and push. This is the checkpoint commit — Verify: no open
  findings remain, and every CI job on the draft PR is green on this commit.

**Checkpoint**: all P1 stories are done. Every change is checked by CI.

---

## Phase 7: User Story 5 — The first administrator exists after first start (Priority: P2)

**Goal**: the idempotent bootstrap creates one admin and prints one link, and
`admin:create` works from the server CLI only.

**Independent Test**: a fresh start gives one admin and one link. A restart does nothing.
`admin:create` adds a second admin with an operator audit entry.

### Tests for User Story 5 (write first, run, see them fail)

- [X] T075 [P] [US5] One-time token tests — `backend/tests/integration/tokens.test.ts`:
  - 256-bit token; only the SHA-256 hash is stored
  - `RESET` expires after 30 minutes
  - issuing a new token sets `superseded_at` on the earlier unused one of the same purpose

  — FR-035 — Verify: fails.
- [X] T076 [P] [US5] Bootstrap tests — `backend/tests/integration/bootstrap.test.ts`:
  - no admin → one `ACTIVE` `{ADMIN}` user with a null password hash, one `RESET` token,
    audit `ADMIN_CREATED` with `SYSTEM` and `details.source = "bootstrap"`, and exactly one
    `oneTimeLink` log line
  - a second run → nothing created or printed; 10 consecutive runs → still exactly one
    admin and one printed link (SC-006)
  - two concurrent runs → one admin
  - variables missing with no admin → non-zero exit; variables missing with an admin
    present → no-op
  - the email belongs to a non-admin → non-zero exit, nobody promoted

  Test names cite `FR-ADM-04` — FR-032, SC-006 — Verify: fails.
- [X] T077 [P] [US5] CLI tests — `backend/tests/integration/cli-admin-create.test.ts`:
  - success → user, token, printed link block, audit `ADMIN_CREATED` with `OPERATOR` plus
    `osUser` and `host`, exit 0
  - an existing email → `ERROR EMAIL_IN_USE` on stderr, exit 2, no change
  - missing or invalid flags → exit 1
  - database unreachable → exit 3

  Also `backend/tests/integration/route-table.test.ts`: no HTTP route reaches CLI or
  bootstrap code, and the public app has no `/metrics` route — FR-033, FR-034 — Verify:
  fails.
- [X] T078 [US5] Traceability: FR-ADM-04 → `Tested`; FR-ADM-05, FR-ACC-03 (partial) →
  `Tested` — `docs/traceability.md`.

### Implementation for User Story 5

- [X] T079 [US5] One-time tokens table — `backend/prisma/migrations/0005_one_time_tokens/migration.sql`.
  Columns:
  - `purpose` "`RESET` | `VERIFY_EMAIL` (`CHECK`)"
  - `token_hash` bytea `UNIQUE`
  - `expires_at`, `used_at`, `superseded_at`

  Indexes `(user_id, purpose) WHERE used_at IS NULL AND superseded_at IS NULL` and
  `(COALESCE(used_at, superseded_at, expires_at))`, the same expression as the purge rule.
  Grants: `po_app` gets `SELECT, INSERT, UPDATE`;
  `po_maintenance` gets `SELECT, DELETE`. Also update `roles.test.ts`'s expected list —
  FR-035 — Verify: T051 still passes with the new table.
- [X] T080 [US5] Token service and minimal user repository —
  `backend/src/tokens/one-time.ts` (create, hash, supersede),
  `backend/src/users/repository.ts` (find by email, any admin exists, create admin) —
  FR-035 — Verify: T075 passes.
- [X] T081 [US5] Bootstrap — `backend/src/db/locks.ts` (`ADMIN_LOCK`, `PURGE_LOCK`
  constants), `backend/src/bootstrap/run.ts` (`pg_advisory_xact_lock(ADMIN_LOCK)`,
  `SYSTEM` context, create, audit, print the link block through the `oneTimeLink`
  channel), step 3 in `backend/src/migrate/run.ts` as `po_app`, and `migrate`'s
  `BOOTSTRAP_ADMIN_*` variables in `docker-compose.yml` — FR-032 — Verify: T076 passes,
  and `docker compose logs migrate` shows one link.
- [X] T082 [US5] Operator CLI and `admin:create` — `backend/src/cli/admin.ts` (extends
  T004's stub: `util.parseArgs`, Zod argument validation, exit codes 0/1/2/3, `OPERATOR` context with
  `os.userInfo().username` and `os.hostname()`), `backend/src/cli/commands/admin-create.ts`,
  with the `admin` script unchanged (`node dist/cli/admin.js`; see
  [contracts/cli.md](contracts/cli.md))
  — FR-033, FR-034 — Verify: T077 passes, and `docker compose exec api npm run admin --
  admin:create --email second@example.local --name "Second Admin"` prints a link.
- [X] T083 [US5] Traceability: FR-ADM-04 → `Done` — `docs/traceability.md` (FR-ADM-05 and
  FR-ACC-03 stay `Tested` until slices 1 and 4).

- [X] T084 [US5] Story checkpoint review: run `/code-review` and `/security-review` over this story's
  commits, fix every finding (each fix in its own commit, with a test where the
  finding is a bug), and push. This is the checkpoint commit — Verify: no open
  findings remain, and every CI job on the draft PR is green on this commit.

**Checkpoint**: slice 1 has an administrator to work with.

---

## Phase 8: User Story 6 — Application shell for the end user (Priority: P2)

**Goal**: routing, page states, the error boundary with request id, ConfirmDialog, the
unsaved-changes guard, a strict CSP, zero axe violations, and the bundle budget, in CI.

**Independent Test**: navigate the shell and the dev-only demo route. Every state and the
dialog behave as specified, axe is clean, and the budget passes.

### Tests for User Story 6 (write first, run, see them fail)

- [X] T085 [P] [US6] ConfirmDialog tests — `frontend/tests/ConfirmDialog.test.tsx`:
  - `role="alertdialog"`, labelled and described
  - initial focus on the safe button
  - Escape, outside click and the safe button close it, except while pending
  - a double click calls `onConfirm` once
  - with a reason: confirm disabled until valid
  - an error and its `errorActions` render inside
  - focus returns to the trigger
  - `vitest-axe` reports no violations

  — FR-025, FR-027, SC-007 — Verify: `npm test -w frontend` fails.
- [X] T086 [P] [US6] Page state tests — `frontend/tests/states.test.tsx`:
  - `Loading`, `Empty` and `ErrorState`: shows the request id; Retry only for
    `SERVICE_UNAVAILABLE` and `CONCURRENCY_RETRY_EXHAUSTED`
  - `RouteErrorBoundary` contains a throwing route and keeps navigation working
  - `useQueryStates`
  - the error message map has an entry for every registry code

  — FR-023, FR-024 — Verify: fails.
- [X] T087 [P] [US6] Unsaved-changes guard tests — `frontend/tests/useUnsavedChangesGuard.test.tsx`
  (a memory data router: navigation while dirty opens the discard dialog, and confirm
  navigates; `beforeunload` is registered only while dirty) — FR-026 — Verify: fails.
- [X] T088 [P] [US6] Router and not-found tests — `frontend/tests/router.test.tsx` (routes
  render; an unknown path renders NotFound; the production route table has no `__demo`) —
  FR-023 — Verify: fails.
- [X] T089 [P] [US6] Header and bundle checks:
  - `scripts/tests/security-headers.test.mjs`: the CSP and headers in
    `deploy/nginx/default.conf` equal those in `deploy/security-headers.mjs`
  - `scripts/tests/check-bundle-budget.test.mjs`: a fixture manifest over and under the
    budget

  — FR-027, FR-028 — Verify: `node --test scripts/tests` fails.
- [X] T090 [P] [US6] End-to-end shell tests — `frontend/e2e/shell.spec.ts` and
  `frontend/playwright.config.ts` (Chromium project, JSON reporter to
  `reports/playwright.json`):
  - navigation and not-found
  - `@axe-core/playwright` on every page, with zero violations
  - the exact production `Content-Security-Policy` header
  - no inline `<script>` in the HTML

  Test names cite `NFR-FE-07` and `NFR-FE-05` — FR-027, FR-041, SC-007 — Verify:
  `npm run e2e` fails against the running stack.
- [X] T091 [US6] Traceability: NFR-FE-01, NFR-FE-05 → `Tested`; NFR-FE-04, NFR-FE-06,
  NFR-FE-07, NFR-FE-09 (partial) → `Tested` — `docs/traceability.md`.

### Implementation for User Story 6

- [ ] T092 [US6] Router, shell and pages — `frontend/src/app/router.tsx`
  (`createBrowserRouter`, lazy routes), `frontend/src/app/Shell.tsx`,
  `frontend/src/app/providers.tsx` (QueryClient), `frontend/src/pages/Home.tsx`,
  `frontend/src/pages/NotFound.tsx` — FR-023 — Verify: T088 passes.
- [ ] T093 [US6] ConfirmDialog — `frontend/src/components/ConfirmDialog.tsx` and
  `ConfirmDialog.module.css` (React Aria `Modal` and `Dialog`, `role="alertdialog"`,
  `autoFocus` on the safe button; see [contracts/ui-components.md](contracts/ui-components.md)),
  plus an ESLint rule in `eslint.config.mjs` that bans the `confirmLabel` literals "OK" and
  "Yes" — FR-025 — Verify: T085 passes.
- [ ] T094 [US6] Page states, error boundary and message map —
  `frontend/src/components/{Loading,Empty,ErrorState,RouteErrorBoundary}.tsx`,
  `frontend/src/hooks/useQueryStates.ts`, `frontend/src/errors/messages.ts` — FR-023,
  FR-024 — Verify: T086 passes.
- [ ] T095 [US6] Unsaved-changes guard and demo route —
  `frontend/src/hooks/useUnsavedChangesGuard.ts` (`useBlocker` + `beforeunload`),
  `frontend/src/pages/__demo/Demo.tsx` (every component in every state), registered only
  under `import.meta.env.DEV` in `router.tsx` — FR-026 — Verify: T087 and T088 pass.
- [ ] T096 [US6] Security headers source and nginx headers — `deploy/security-headers.mjs`
  (the CSP from research R18, `X-Content-Type-Options`, `Referrer-Policy`,
  `frame-ancestors`), headers added to `deploy/nginx/default.conf` — FR-027 — Verify:
  T089's header test passes, and T090's CSP check passes against the rebuilt stack.
- [ ] T097 [US6] Bundle budget and the CI web job — `scripts/check-bundle-budget.mjs`
  (Vite manifest; entry plus static imports ≤ 200 KB gzip, each lazy chunk ≤ 150 KB), root
  script `check:bundle`, and a `web` job in `.github/workflows/ci.yml` (unit, component and
  axe tests, build, budget; uploads reports). `traceability` now `needs` `web` too — FR-028,
  FR-038 — Verify: T089's budget test passes, and `web` is green on the draft PR.
- [ ] T098 [US6] Playwright in CI and nightly — the `e2e` job runs `npm run e2e` after the
  smoke test (Chromium on PRs; Chromium, Firefox and WebKit on push to `main`), and
  `.github/workflows/nightly.yml` (schedule plus manual trigger, all three engines, same
  public-repo rules) — FR-041, FR-038 — Verify: T090 passes in CI, and a manual nightly run
  is green.
- [ ] T099 [US6] Traceability: NFR-FE-05 → `Done`. NFR-FE-01 stays `Tested` (partial):
  its `VERSION_CONFLICT` reload prompt lands with order versions in slice 3, which
  completes the row. NFR-FE-04/06/07/09 also stay `Tested` until their later parts —
  `docs/traceability.md`.

- [ ] T100 [US6] Story checkpoint review: run `/code-review` over this story's
  commits, fix every finding (each fix in its own commit, with a test where the
  finding is a bug), and push. This is the checkpoint commit — Verify: no open
  findings remain, and every CI job on the draft PR is green on this commit.

**Checkpoint**: later slices build screens on tested patterns.

---

## Phase 9: User Story 7 — Mail can be sent safely (Priority: P3)

**Goal**: one mailer interface, sending after commit only, failures logged, Mailpit
locally.

**Independent Test**: a commit sends once, a rollback sends nothing, and a send failure is
logged without failing the request.

### Tests for User Story 7 (write first, run, see them fail)

- [ ] T101 [P] [US7] Mail pipeline tests — `backend/tests/integration/mail.test.ts`, using a
  test-only route and template with `CaptureMailer`:
  - a committed transaction sends exactly one message
  - a rolled-back one sends none
  - a mailer that throws → a `mail_send_failed` security log line, and the request still
    `200`
  - the API starts and passes readiness while the SMTP host is unreachable (only the
    settings' shape is validated at startup; spec edge case)

  Test names cite `NFR-OPS-04` — FR-029, FR-030 — Verify: fails.
- [ ] T102 [US7] Traceability: NFR-OPS-04 → `Tested` — `docs/traceability.md`.

### Implementation for User Story 7

- [ ] T103 [US7] Mailer — `backend/src/mail/mailer.ts` (interface), `backend/src/mail/smtp.ts`
  (nodemailer; config validated, not connected at startup), `backend/src/mail/capture.ts`,
  `backend/src/mail/send-after-commit.ts` (`ctx.afterCommit(() => mailer.send(...))`, with
  failures logged and swallowed) — FR-029, FR-030 — Verify: T101 passes, and `smoke.sh`
  still reaches Mailpit.
- [ ] T104 [US7] Traceability: NFR-OPS-04 → `Done` — `docs/traceability.md`.

- [ ] T105 [US7] Story checkpoint review: run `/code-review` over this story's
  commits, fix every finding (each fix in its own commit, with a test where the
  finding is a bug), and push. This is the checkpoint commit — Verify: no open
  findings remain, and every CI job on the draft PR is green on this commit.

**Checkpoint**: slice 1 can send verification and reset mail safely.

---

## Phase 10: User Story 8 — Old data is purged on schedule (Priority: P3)

**Goal**: a daily purge under the maintenance role, one run at a time, covering the data
that exists so far.

**Independent Test**: seeded rows on both sides of each limit; only expired rows go; a
second concurrent run is a no-op.

### Tests for User Story 8 (write first, run, see them fail)

- [ ] T106 [P] [US8] Purge tests — `backend/tests/integration/purge.test.ts`, with an
  injected `asOf` timestamp:
  - audit entries older than 8 years are deleted, and newer ones kept
  - tokens deleted when "`COALESCE(used_at, superseded_at, expires_at) < now() - 7 days`",
    and others kept
  - batches of 1,000, looping until done
  - one log line per table with its count
  - a second run while the lock is held logs `already running` and deletes nothing
  - a run killed mid-way releases the lock
  - the same deletes as `po_app` → permission denied

  Test names cite `NFR-OPS-05` — FR-036, FR-037 — Verify: fails.
- [ ] T107 [US8] Traceability: NFR-OPS-05 (partial) → `Tested` — `docs/traceability.md`.

### Implementation for User Story 8

- [ ] T108 [US8] Purge tasks — `backend/src/maintenance/purge.ts`
  (`pg_try_advisory_lock(PURGE_LOCK)` on a dedicated connection; tasks `audit_entries`
  (8 years) and `one_time_tokens` (7 days), registered in
  `backend/src/maintenance/registry.ts`) — FR-036, FR-037 — Verify: T106 passes, and
  `docker compose logs maintenance` shows counts for both tables.
- [ ] T109 [US8] Smoke check of the maintenance first run — `scripts/smoke.sh` asserts that
  `maintenance` logged `purge run complete` with both table names — FR-036 — Verify: the
  `e2e` job is green.

- [ ] T110 [US8] Story checkpoint review: run `/code-review` over this story's
  commits, fix every finding (each fix in its own commit, with a test where the
  finding is a bug), and push. This is the checkpoint commit — Verify: no open
  findings remain, and every CI job on the draft PR is green on this commit.

**Checkpoint**: every story is complete.

---

## Phase 11: Polish and cross-cutting

- [ ] T111 Developer inner loop (research R25):
  - `compose.dev.yaml` (db on `127.0.0.1:5432`, Mailpit SMTP on `127.0.0.1:1025`)
  - `scripts/dev-env.mjs` (`.env` with hosts rewritten to `127.0.0.1`; passes the API only
    its own variables)
  - root script `dev` (concurrently: `docker compose -f docker-compose.yml -f
    compose.dev.yaml up -d db migrate mailpit`, `tsx watch backend/src/server.ts`, and Vite
    on port 8080)
  - `frontend/vite.config.ts` (proxy `/api/` to the API, `server.headers` from
    `deploy/security-headers.mjs`, `html.cspNonce` dev only)

  — Verify: quickstart §5 behaves as written, and the compose file test (T024) still passes,
  because the production compose is unchanged.
- [ ] T112 [P] CLAUDE.md commands match reality — `CLAUDE.md` (`npm run dev`, `npm test`,
  `npm run lint`, `npm run typecheck`; fix anything that differs; stay under 60 lines) —
  Verify: each listed command runs successfully.
- [ ] T113 [P] Traceability final pass — `docs/traceability.md`. NFR-OPS-02 → `Done` (all
  parts: config, production refusals, credential separation, headers, metrics, gitleaks).
  Confirm every slice 0 row is `Done` (fully delivered) or `Tested` (partial, with the
  remaining slice noted in the spec) — Verify: `npm run check:traceability` passes.
- [ ] T114 CI self-test record, for SC-004 — `specs/001-foundation/ci-selftest.md`. CI runs
  only on PRs to `main`, so for each check: open a throwaway **draft PR** from a
  `selftest/<check>` branch with one deliberate break, record the job that failed and the
  run link, then **close the PR and delete the branch immediately**. The checks to break:
  - style, types, ID ban
  - migration
  - contract drift, breaking change without the label
  - traceability
  - an axe violation, bundle over budget
  - smoke
  - a committed fake secret (gitleaks). Use an obviously fake value copied from
    gitleaks' own test fixtures for a rule it detects (for example its `testdata` sample
    for the GitHub personal-access-token rule). Confirm it triggers locally with the pinned
    image before pushing, and never use a real-looking value of your own.

  — SC-004 — Verify: every row shows only the intended job failing, and
  `gh pr list --state open --search "head:selftest/"` returns nothing.
- [ ] T115 Quickstart run-through, for SC-001 and SC-008 —
  `specs/001-foundation/quickstart-results.md`. Run every step of
  [quickstart.md](quickstart.md) from a clean clone; record outputs, the clean-start time
  (target < 10 min) and the CI wall time (target < 15 min); fix the quickstart or the code
  for any mismatch — Verify: every step matches its expected result.
- [ ] T116 Mark the draft PR **ready for review**, with full CI green.
  - Every `ci.yml` job (`static`, `api`, `contract`, `web`, `audit`, `e2e`, `traceability`,
    `secrets`) passes on the PR's last commit.
  - Run the final full `/code-review` and `/security-review` over the whole PR, and resolve
    the findings (constitution review gate).
  - Then `gh pr ready`.

  — Verify: `gh pr view --json isDraft` shows `false`, and the checks page is all green.
- [ ] T117 **Manual GitHub settings step**: enable branch protection on `main` — require
  every `ci.yml` job above and the `breaking` job of `contract-breaking.yml`, require the PR
  to be up to date, no force pushes, no deletion.
  Record who did it and when in `specs/001-foundation/quickstart-results.md` — Verify: a
  test push straight to `main` is rejected, and the PR shows the required checks.

---

## Dependencies and execution order

Because of the review gate, stories run **in sequence**. Each one starts after the
previous story's checkpoint review is green on the draft PR. Parallel work happens
**within** a story, on its `[P]` tasks.

- **Setup (T001–T011)**: T001 first, then T002. T003–T005 [P] after T002. T006 and T007
  after T003–T005. T008 after T006. **T009 (draft PR) after T008.** T010 and T011 [P] after
  T009.
- **Foundational (T012–T019)**: needs Setup. T014 → T015 → T016 → T017 and T018 → T019.
  T012 → T013 can run alongside T014.
- **US1 (T020–T037)**: tests T020–T024 [P], then T025 and T026. Then T027–T030 (each after
  its test), T030a, T031 and T032 [P], T033, T034 (needs T027–T033), T035, T036, and review T037.
- **US3 (T038–T050)**: tests T038–T042 [P], then T043, implementation T044–T049, review
  T050. It builds on US1's app factory (T017) and server (T029).
- **US4 (T051–T058)**: tests T051–T052 [P], then T053, implementation T054–T057, review
  T058.
- **US2 (T059–T074)**: needs US3's registry and routes, and US4's migrations. Tests
  T059–T063 [P], then T064, implementation T065–T073, review T074.
- **US5 (T075–T084)**: needs US4's users and audit, and US3's `oneTimeLink` channel. Tests
  T075–T077 [P], then T078, implementation T079–T083, review T084.
- **US6 (T085–T100)**: needs US2's generated client (T070) and US1's web image (T032).
  Tests T085–T090 [P], then T091, implementation T092–T099, review T100.
- **US7 (T101–T105)**: needs Foundational `afterCommit` (T018) and US3's logger. Review
  T105.
- **US8 (T106–T110)**: needs US4's audit table, US5's tokens table and US1's loop (T033).
  Review T110.
- **Polish (T111–T117)**: T111–T115 after US8's review. T116 after T111–T115. T117 last.

### Critical path

The whole chain is sequential at story level:

Setup → Foundational → US1 → US3 → US4 → US2 → US5 → US6 → US7 → US8 → Polish

The longest task chain through it, with `[P]` siblings left out:

T001 → T002 → T004 → T006 → T008 → **T009** → T014 → T015 → T016 → T017 → T020 → T027 →
T028 → T029 → T034 → T035 → **T037** → T039 → T044 → T046 → **T050** → T051 → T054 → T055
→ **T058** → T062 → T068 → T070 → T072 → **T074** → T076 → T081 → T082 → **T084** → T085
→ T093 → T097 → T098 → **T100** → T101 → T103 → **T105** → T106 → T108 → **T110** → T111
→ T114 → T115 → T116 → T117

The bold tasks are the draft PR and the eight checkpoint reviews. The reviews are the gates
where CI must be green. US1, US3, US2 and US6 carry the most work: the stack, the error
format, the contract pipeline and the web CI job.

## Parallel examples

- **US1 tests**: T020, T021, T022, T023 and T024 together. They're in different files.
- **US1 images**: T031 (API Dockerfile) and T032 (web Dockerfile and nginx) together.
- **US3 tests**: T038, T039, T040, T041 and T042 together.
- **US2 tests**: T059, T060, T061, T062 and T063 together.
- **US6 tests**: T085, T086, T087, T088, T089 and T090 together.

## Implementation strategy

1. **MVP = Setup + Foundational + US1**: a stack that starts with one command, tested in CI.
   Stop and run quickstart §1.
2. Then the remaining P1 stories (US3, US4, US2). After them, every change is held to the
   full bar.
3. Then the P2 stories (US5 admin, US6 shell), then P3 (US7 mail, US8 purge). Each ends at a
   checkpoint with its traceability rows moved forward.
4. Polish: the dev loop, the docs, the CI self-test, the quickstart run-through, the PR to
   green, and branch protection.
