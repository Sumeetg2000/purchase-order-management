# Research: Slice 0 — Foundation

Each entry gives the decision, why it was chosen, and the alternatives considered. Where an
ADR already decides the matter, the entry only records how the slice applies it. Versions
are the current stable release when the slice starts, and every version is pinned exactly
in `package-lock.json` and in image tags (`node:24.x-alpine`, `postgres:17.x`).

## R1. Runtime versions
- **Decision**: Node.js 24 (the active LTS line); TypeScript 6.0 with `strict`;
  PostgreSQL 17, the same major in compose, tests and CI.
  - **Updated at T003**: npm's `latest` TypeScript is 7.0, the native compiler, but
    typescript-eslint supports TypeScript below 6.1. So the project pins 6.0.x, the last
    release on the JavaScript compiler, and revisits once typescript-eslint supports 7.
- **Rationale**: ADR-0020 asks for the active LTS and PostgreSQL 16+. PostgreSQL 17 is
  mature and supports everything ADR-0003 needs: statement-level triggers with transition
  tables, generated columns and column privileges.
- **Alternatives**: Node 22 (maintenance LTS, shorter support); PostgreSQL 18 (newest,
  but it gains nothing we need yet).

## R2. Repository layout
- **Decision**: one repository using npm workspaces:
  - `backend`: Express API, the operator CLI, the bootstrap and the purge
  - `frontend`: React app
  - `packages/contracts`: Zod schemas, the error registry and the OpenAPI generator
  - The root holds shared tooling, scripts and CI.
- **Rationale**: the contract package must be shared by the API and the web app (ADR-0008).
  Workspaces are built into npm, which CLAUDE.md already uses (`npm run …`), so no extra
  tool is needed.
- **Alternatives**: pnpm or Turborepo (faster, but one more tool for no current need);
  separate repositories (break the single contract source).

## R3. HTTP layer
- **Decision**: Express 5. A small `defineRoute({ method, path, access, request, responses,
  handler })` helper registers each route with its Zod schemas and its declared `access`.
  At startup, any route without `access`, and any route the OpenAPI document doesn't
  describe, fails the process. In slice 0 the only `access` value is `public`. Slice 1
  adds the authenticated values.
- **Rationale**: Express is in the stack. Express 5 handles async errors natively. One
  registration point gives deny-by-default (Principle III), strict validation (VI) and the
  route-table checks (no HTTP route to CLI commands; `/metrics` never on the public app).
- **Alternatives**: Express 4 (manual async error wrappers); annotation-based frameworks
  (outside the chosen stack).

## R4. Error format and code registry
- **Decision**:
  - `packages/contracts/src/errors.ts` holds the registry: code → HTTP status, title, and
    whether field details apply. The API, the OpenAPI generator and the web app's message
    map all import it.
  - The API throws typed `AppError(code, details?)`. One Express error middleware renders
    RFC 9457 `application/problem+json`: `type`, `title`, `status`, `detail`, `code`,
    `correlationId`, `details`.
  - Codes used in slice 0:
    - `VALIDATION_FAILED`, with field codes `MALFORMED_JSON` and `UNSUPPORTED_MEDIA_TYPE`
      in addition to schema failures
    - `PAYLOAD_TOO_LARGE` (413)
    - `CSRF_REJECTED` (403, a disallowed `Origin` header, R18). ADR-0007 already defines it
      to cover this, so slice 1 adds the token check without a new code.
    - `NOT_FOUND`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `CONCURRENCY_RETRY_EXHAUSTED`
  - The registry grows slice by slice, as ADR-0007 lists.
- **ADR update**: ADR-0007 gains `413 PAYLOAD_TOO_LARGE` and the field codes
  `MALFORMED_JSON` and `UNSUPPORTED_MEDIA_TYPE`. ADR-0007 was silent on oversized and
  non-JSON bodies, and `413` is the standard status for the first.
- **Alternatives**: `400` for oversized bodies (non-standard; clients and proxies expect
  `413`); a separate registry per app (drifts).

## R5. Database errors and transactions
- **Decision**:
  - `db/errors.ts` is the only place that maps database and ORM errors to registry codes.
    A lint rule bans reading `error.message` outside it.
  - **Error shapes, as measured** with Prisma 7.10.1, `@prisma/adapter-pg` 7.10.1 and `pg`
    8.23.1 against PostgreSQL 17 (a probe before Phase 2, kept as the regression test
    `db-error-shapes.test.ts`). P2024 never appears with the driver adapter.

    | Situation | What is thrown | Maps to |
    |---|---|---|
    | Pool exhausted, query outside a transaction | a bare `Error` from pg-pool: message `timeout exceeded when trying to connect`, no `code` (Prisma only adds `clientVersion`) | `503 SERVICE_UNAVAILABLE` |
    | Pool exhausted, interactive transaction waits past `maxWait` | `PrismaClientKnownRequestError` `P2028` ("Unable to start a transaction in the given time") | `503 SERVICE_UNAVAILABLE` |
    | Interactive transaction runs past `timeout` | `P2028`, `meta.timeout` and `meta.timeTaken` set | `503 SERVICE_UNAVAILABLE` |
    | SQLSTATE `40001` / `40P01` | `P2010`, `meta.driverAdapterError.cause.kind = 'TransactionWriteConflict'`, `cause.originalCode` = the SQLSTATE (also accept `P2034`) | retried; then `503 CONCURRENCY_RETRY_EXHAUSTED` |
    | Database unreachable | locally: `P2010`, `cause.kind = 'DatabaseNotReachable'`. On the CI runner: the raw pg connect `Error` with `code: 'ECONNREFUSED'`, not wrapped by the adapter. Seen in the first CI run; the probe had only run locally. Node socket codes (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`) are matched by code | `503 SERVICE_UNAVAILABLE` |
    | Unique violation (model API) | `P2002`, `cause.constraint.index` names the constraint | per constraint, slice by slice |
    | Error raised by our triggers | `P2010`, `cause.originalCode` = our custom SQLSTATE (R6) | per code |

  - **The one message match**: pg-pool's timeout error has no code, so `db/errors.ts`
    recognises it by its exact message. It's the only message match in the codebase, it
    lives only in `db/errors.ts`, and the regression test pinned to `pg` 8.23.1 fails if an
    upgrade changes the message. Recorded in ADR-0007. Every query except readiness's
    `SELECT 1` runs inside `withTransaction`, where pool waits arrive as `P2028` anyway.
  - `withTransaction(ctx, fn)` wraps every interactive transaction:
    - explicit `timeout` and `maxWait`
    - sets the actor context (R6)
    - retries `40001` and `40P01` up to 3 times with jitter
    - maps pool and transaction timeouts (`P2028` and the pg-pool timeout) to `503`
    - collects `afterCommit` callbacks and runs them only once the transaction has
      committed
- **Rationale**: Principle V and ADR-0006. Running `afterCommit` here enforces
  "mail after commit" (ADR-0017) by construction.
- **Alternatives**: an ad-hoc `try/catch` per repository (violates "one place");
  sending mail inside the transaction (forbidden).

## R6. Actor context and audit enforcement
- **Decision**:
  - At the start of each transaction, `withTransaction` sets transaction-local settings with
    `set_config(name, value, true)`:
    - `app.actor_type`, `app.actor_user_id`, `app.acting_role`
    - `app.actor_name`, `app.actor_email`
    - `app.os_user`, `app.os_host`
    - `app.request_id`
  - A trigger function `require_actor_context()` (`BEFORE INSERT OR UPDATE OR DELETE`)
    raises `ACTOR_CONTEXT_REQUIRED` when `app.actor_type` is missing.
    - **Our trigger errors use custom SQLSTATE codes**, so `db/errors.ts` maps them by
      code, never by message: class `PO` (unused by PostgreSQL), `PO001`
      `ACTOR_CONTEXT_REQUIRED`, `PO002` `ACTOR_CONTEXT_MISMATCH`. Later slices add more,
      for example `PO003` `DERIVED_VALUE_READ_ONLY`.
    - **Updated at T055**: `PO004` `AUDIT_RETENTION_ACTIVE` is raised by a `BEFORE DELETE`
      row trigger on `audit_entries` for any entry younger than 8 years, for every role
      including the owner. A grant can't limit `po_maintenance`'s `DELETE` to expired
      rows; the trigger does. `PO001` also covers an incomplete or inconsistent context
      (a `USER` without its user id, name, email or acting role; an `OPERATOR` without
      OS user or host; a `SYSTEM` context carrying actor fields). The trigger functions
      are `SECURITY INVOKER` with `search_path = pg_catalog, pg_temp`, owned by
      `po_owner`, with `EXECUTE` revoked from `PUBLIC` (triggers fire without it). The adapter exposes them as
      `cause.originalCode`. It's attached to every
    audited table: `users` in slice 0, and more in later slices.
  - Service code writes audit rows explicitly, in the same transaction. A `BEFORE INSERT`
    trigger on `audit_entries` fills `request_id` and the actor fields from the context, and
    refuses a row whose actor fields contradict it.
  - A `CHECK` ties the actor fields to `actor_type` (ADR-0016).
- **Rationale**: settings set with `set_config(..., true)` disappear at commit or rollback,
  so a pooled connection can't carry stale context. Raw SQL without context is refused
  (FR-018, Principle IV).
- **Alternatives**: session-level `SET` (leaks across pooled connections); writing audit
  rows only from triggers (can't express business-level "before → after" without
  duplicating domain logic in SQL).

## R7. Database roles and provisioning
- **Decision**:
  - A one-shot `migrate` compose service runs three steps in order, using the image of the
    API:
    1. `db-init`: as the PostgreSQL superuser, idempotently creates roles `po_owner`,
       `po_app` and `po_maintenance`, each with its own password from `.env`. All are
       `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`. `po_owner` owns the database and
       schema.
    2. `prisma migrate deploy`, as `po_owner`. Migrations contain the raw SQL for
       triggers, functions, `CHECK`s and `GRANT`s to the other two roles by name.
       `PUBLIC` loses all rights on the schema.
    3. The bootstrap (R13), as `po_app`.
  - The API connects as `po_app`, and the maintenance service as `po_maintenance`.
  - Integration tests run the same steps against a Testcontainers PostgreSQL 17.
- **Rationale**: ADR-0003 and ADR-0020. Roles are cluster-level objects, so they need a
  superuser step that Prisma migrations can't do. Keeping it idempotent and inside
  `migrate` means `docker compose up` remains the only step.
- **Alternatives**: `docker-entrypoint-initdb.d` scripts (run only on an empty data volume,
  so password or role changes are never applied); a single shared role (violates least
  privilege).

## R8. Prisma's role
- **Decision**: Prisma 7 for the client, the schema and migration files.
  - **Updated at T004**: Prisma 7 needs a driver adapter, so the client connects through
    `@prisma/adapter-pg` over `pg`. The project pins the stable 7.10.1, because npm's
    `latest` tag for the CLI points at an 8.0 release candidate.
  - npm 11 runs install scripts only for packages on the root `allowScripts` list, pinned
    to exact versions: `prisma` and `@prisma/engines` (the schema engine `migrate`
    needs), and `esbuild` (tsx and Vite). Every trigger,
  function, privilege and `CHECK` lives as raw SQL in the migration. A schema
  introspection test compares the live privileges, triggers and constraints against an
  expected list.
- **Rationale**: this is the stack ADR-0020 chose. Prisma can't express triggers or
  grants, so raw SQL migrations are its documented path.
- **Alternatives**: a separate migration tool (two sources of schema truth).

## R9. Configuration validation
- **Decision**: one Zod schema per process (`api`, `migrate`, `maintenance`, `cli`)
  validates `process.env` at startup.
  - On failure it prints each invalid key and the reason, never the value, and exits `1`.
  - Production rules: with `APP_ENV=production`, it refuses `SEED_DEMO_DATA=true` and an
    SMTP host of `mailpit`.
  - **Credential separation**: each process accepts only its own database credentials, and
    refuses to start otherwise.
    - API and CLI: they refuse if `OWNER_DATABASE_URL`, `POSTGRES_PASSWORD`,
      `MAINTENANCE_DATABASE_URL` or any `DB_*_PASSWORD` is present, or if the user in
      `DATABASE_URL` isn't `po_app`.
    - Maintenance: it refuses every database variable except `MAINTENANCE_DATABASE_URL`,
      and refuses if that URL's user isn't `po_maintenance`.
    - Migrate: it's the only process given the superuser and owner credentials. It uses
      them for steps 1 and 2, and `DATABASE_URL` (`po_app`) for the bootstrap.
    - Compose passes each service only its own variables, never the whole `.env`
      (`environment:` lists, no `env_file` on `api` or `maintenance`). The config check
      is the backstop if someone gets that wrong.
  - The full variable list is in [contracts/config.md](contracts/config.md).
- **Rationale**: FR-003 and FR-004. Using Zod reuses the contract library and its error
  formatting.
- **Alternatives**: envalid or convict (one more library for the same job).

## R10. Logging, correlation and redaction
- **Decision**:
  - pino with pino-http, writing JSON to stdout.
  - Correlation id header `X-Request-Id`: accepted if it matches `^[A-Za-z0-9._-]{8,36}$`,
    otherwise replaced with a UUIDv7. It's echoed in the response header, bound to every log
    line through a per-request child logger, put in problem bodies as `correlationId`, and
    set as `app.request_id` in the actor context.
    - **Updated at the US3 review**: the limit was 64. It is 36, which still fits a UUID
      and stays below the 43-character run the log checks treat as a token (SC-003), so a
      client-chosen id can never look like a secret in the logs.
  - pino `redact` paths cover cookies, `authorization`, `set-cookie`, any `password`,
    `token`, `secret` or `phone` key, at any depth.
  - The bootstrap and `admin:create` print their link with a dedicated logger call marked
    `{ oneTimeLink: true }`, which is the only allowed path. A test asserts no other log line
    contains a token-shaped value.
- **Rationale**: FR-012, FR-013 and ADR-0020.
- **Alternatives**: winston (slower, and redaction is less mature); trace context via
  OpenTelemetry (no tracing backend in scope yet; `X-Request-Id` can map to it later).

## R11. Metrics
- **Decision**: prom-client exposes HTTP request duration histograms and error counters,
  plus default process metrics.
  - They're served by a second, minimal HTTP listener on `METRICS_PORT` (default `9464`).
  - Compose uses `expose: ["9464"]` and never `ports`.
  - nginx has an explicit `location = /metrics { return 404; }`, and proxies only
    `/api/`.
- **Rationale**: Clarification 2 and ADR-0020. A separate listener means the public app
  can't serve it even if routing is misconfigured.
- **Alternatives**: `/metrics` on the main port behind a check (easy to expose by
  mistake).

## R12. Contract pipeline
- **Decision**:
  - Zod 4 schemas in `packages/contracts`. `zod-openapi` builds the OpenAPI 3.1 document
    from the route definitions and the error registry. Every registry code appears in an
    `ErrorCode` enum schema, and each operation lists its codes.
  - `npm run contract:generate` writes `packages/contracts/openapi/openapi.json`, which is
    committed.
  - CI runs the generator and fails on `git diff --exit-code` (drift).
  - CI runs `oasdiff breaking` against `main`'s committed document, and fails unless the PR
    has the `breaking` label (ADR-0008).
  - The web app generates types with `openapi-typescript`, and calls the API through
    `openapi-fetch`, typed from those types.
  - API contract tests validate every response, including errors, against the committed
    document.
- **Rationale**: ADR-0008. `openapi-fetch` is a thin, typed client: no code generation
  beyond types, and a very small bundle.
- **Alternatives**: orval or openapi-generator clients (heavier generated code); a
  hand-written client (drifts).

## R13. Admin bootstrap and operator CLI
- **Decision**:
  - The bootstrap runs as the third step of `migrate` (R7), under
    `pg_advisory_xact_lock(ADMIN_LOCK)` in one transaction, with actor context
    `actor_type = SYSTEM`.
    - If no admin exists, it creates the user and a `RESET` token, and writes the audit
      entry `ADMIN_CREATED` (`details.source = "bootstrap"`).
    - It prints the link `APP_ORIGIN/reset-password?token=…` once.
  - The CLI is `backend/src/cli/admin.ts`, run as `npm run admin -- <command>`.
    - It parses commands with Node's `util.parseArgs` and validates arguments with Zod.
    - Each command runs in one transaction under the same lock, with actor context
      `OPERATOR`, plus `os.userInfo().username` and `os.hostname()`.
    - Exit codes: `0` for success or a no-op, `1` for a usage or validation error, `2` for
      a rule refusal (`EMAIL_IN_USE`). Each error prints `ERROR <CODE>: <message>`.
    - Slice 0 implements `admin:create` only (spec assumption).
  - The printed link points at a page slice 1 builds. Until then it can't be used, and
    after 30 minutes the admin uses forgot-password.
- **ADR update**: ADR-0016's catalogue gives `ADMIN_CREATED` only the `OPERATOR` actor.
  The bootstrap also creates an admin, and the creation must be audited, so the entry
  becomes "`OPERATOR` (CLI) or `SYSTEM` (bootstrap), with `details.source`".
- **Alternatives**: running the bootstrap at API startup (several API replicas would race,
  and the link would mix with request logs); a separate CLI binary (more packaging for no
  benefit).

## R14. Mail
- **Decision**: the `Mailer` interface has `send({ template, to, variables })`.
  - `SmtpMailer` uses nodemailer, with the SMTP config validated at startup but not
    connected (spec edge case).
  - `CaptureMailer` serves tests.
  - Sending happens only through `ctx.afterCommit(() => mailer.send(...))`. A failure is
    logged as a security event (`mail_send_failed`) and swallowed.
  - Mailpit (`axllent/mailpit`) runs under the `local` profile. Its UI is published on
    `127.0.0.1:8025` only, and SMTP is internal.
  - Slice 0 defines no real templates. A test-only template proves the pipeline.
- **Rationale**: ADR-0017 and FR-029–FR-031.
- **Alternatives**: a provider SDK (ties us to one vendor; SMTP is universal).

## R15. Maintenance service
- **Decision**:
  - Same image as the API, command `node dist/maintenance/loop.js`, connecting with
    `MAINTENANCE_DATABASE_URL`.
  - The loop runs the purge at start and then sleeps 24 h.
  - The purge takes `pg_try_advisory_lock(PURGE_LOCK)` on a dedicated connection. If it
    fails, it logs `already running` and exits the run.
  - It deletes in batches of 1,000 rows until none are left, and logs one line per table.
  - In slice 0 it purges `audit_entries` older than 8 years and `one_time_tokens` used or
    expired more than 7 days ago.
- **Rationale**: ADR-0020.
- **Alternatives**: in-container cron (an extra daemon); host cron (outside compose).

## R16. Compose topology
- **Decision**: the services are:
  - `db` (postgres:17)
  - `migrate` (one-shot: db-init → migrate → bootstrap)
  - `api`, which waits for `migrate` to complete successfully
  - `web`: an nginx image that serves the built React app and proxies `/api/` to `api`.
    This is both "the web app" and "the same-origin edge" in the spec.
  - `maintenance`, which also waits for `migrate`
  - `mailpit`, under the `local` profile

  Other details:
  - Health checks: `db` uses `pg_isready`; `api` uses `/healthz`, called with busybox
    `wget` in the alpine image.
  - Only `web` publishes a port to the host (`8080`), plus Mailpit's UI locally. The API is
    reachable only through `web`.
- **Rationale**: same origin (ADR-0017) and the fewest services. One nginx container
  avoids a second web server just to serve static files.
- **Alternatives**: a separate static-file container behind nginx (extra hop, no benefit).

## R17. Frontend stack and component library
- **Decision**:
  - React 19, Vite, React Router 7 in data-router mode (`createBrowserRouter`, required for
    `useBlocker`), TanStack Query 5, and CSS Modules.
  - **Component library: React Aria Components.** Its `Dialog` and `Modal` give
    `role="alertdialog"`, focus trapping and focus return, and its table pairs with
    TanStack Virtual for the 500-line editor in slice 3.
  - The ConfirmDialog, the page states (`Loading`, `Empty`, `ErrorState` with request id
    and retry) and `useUnsavedChangesGuard` (`useBlocker` + `beforeunload`) are built on it.
  - A `/__demo` route exists only when `import.meta.env.DEV` is true, so production builds
    drop it.
- **ADR update**: ADR-0018 deferred the component library to this plan. This records the
  choice.
- **Rationale**: ADR-0018 picks the library by accessibility support and virtualised-table
  fit. React Aria is the strongest on accessibility and is unstyled, so the CSP stays
  strict (no runtime style injection).
- **Alternatives**: MUI (CSS-in-JS injects `<style>` tags, which conflicts with a strict
  CSP without nonces); Mantine (good, but weaker table and virtualisation story);
  Radix primitives (no table or grid primitive).

## R18. CSP and security headers
- **Decision**:
  - nginx sets, for the app:
    `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
    img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self';
    frame-ancestors 'none'; form-action 'self'`
  - plus `X-Content-Type-Options`, `Referrer-Policy: no-referrer` and HSTS when TLS is on.
  - The API applies helmet to its JSON responses, a body limit of 1 MB, and
    `cors: false`. A request whose `Origin` isn't `APP_ORIGIN` → `403 CSRF_REJECTED`.
    Slice 1 adds the CSRF token check to the same middleware, with the same code.
- **Rationale**: ADR-0018 and ADR-0020. Vite's production build emits no inline scripts.
- **Alternatives**: nonces (unneeded with no inline code).

## R19. Testing stack
- **Decision**:
  - API: Vitest, Supertest, and Testcontainers PostgreSQL 17, which runs R7's
    provisioning once per run. Each test gets a fresh database cloned from a migrated
    template (`CREATE DATABASE … TEMPLATE`).
  - Web: Vitest, Testing Library, jsdom, `vitest-axe`, and MSW handlers generated from the
    OpenAPI document.
  - End to end: Playwright with `@axe-core/playwright` against the compose stack. Chromium
    on every pull request; Chromium, Firefox and WebKit nightly and on `main`
    (Clarification 3).
  - Both runners write JSON reports for the traceability check.
- **Rationale**: Principle VIII and ADR-0020. Template databases give isolation in
  milliseconds.
- **Alternatives**: transactions rolled back per test (can't test commit, after-commit or
  roles realistically).

## R20. Requirement-ID ban, traceability and commit checks
- **Decision**:
  - `scripts/check-requirement-ids.mjs` scans tracked source files, excluding `*.test.*`,
    `*.spec.*`, `docs/` and `specs/`, for `\bT\d{3}\b` and `\bN?FR-[A-Z]+-\d+\b`, using an
    allowlist file. It runs in the `lint` job.
  - commitlint (conventional config) adds a custom rule that bans the same patterns in the
    subject. It runs on the PR's commits.
  - `scripts/check-traceability.mjs` parses `docs/traceability.md` and the Vitest and
    Playwright JSON reports, and applies the status rules from ADR-0013. It also checks that
    §1–§8 of `docs/BRIEF.md` each have a row.
- **Rationale**: ADR-0013. Plain Node scripts need no extra dependency.
- **Alternatives**: a custom ESLint rule (misses non-TS files and config).

## R21. Bundle budget
- **Decision**: `scripts/check-bundle-budget.mjs` reads Vite's build manifest and
  gzip-measures:
  - the entry chunk plus its static imports (the shell and login): ≤ 200 KB
  - each lazy route chunk: ≤ 150 KB (ADR-0012)
- **Rationale**: no extra dependency, and it reads exactly what ADR-0012 defines.
- **Alternatives**: size-limit (one more tool, and its "initial" definition differs).

## R22. Browser targets
- **Decision**: browserslist `last 2 Chrome versions, last 2 Edge versions, last 2 Firefox
  versions, last 2 Safari versions`, used by Vite's build target (Clarification 3).
- **Rationale**: matches the support statement exactly.

## R23. CI layout (GitHub Actions)
- **Decision**: `.github/workflows/ci.yml` runs on `pull_request` to `main` and on `push` to
  `main`. Jobs:
  1. `static`: install, lint, Prettier check, typecheck, ID ban; commitlint on PRs.
  2. `api`: unit, integration (Testcontainers, migrations from empty, privilege test,
     reconciliation) and contract tests.
  3. `contract`: drift check and oasdiff, with the label exception.
  4. `web`: unit, component and axe tests, build, and bundle budget.
  5. `audit`: `npm audit --audit-level=high`.
  6. `e2e`: compose up with the local profile, the smoke script (health, readiness, web
     load, maintenance first run, `/metrics` 404 and internal), then Playwright on
     Chromium. On push to `main` it also runs Firefox and WebKit.
  7. `traceability`: runs after `api`, `web` and `e2e`, from their uploaded reports.
  8. `secrets`: gitleaks, run from its official container image (pinned), with
     `.gitleaks.toml`. On a pull request it scans the PR's commit range; on a push to
     `main` it scans the full history.

  `nightly.yml` runs the three-engine Playwright suite (and later the load test). Branch
  protection on `main` requires every `ci.yml` job, `secrets` included.
- **Public-repository rules**:
  - Triggers are `pull_request` and `push` only. **Never `pull_request_target`**, which
    runs fork code with the base repository's secrets and write token.
  - `permissions: contents: read` at workflow level. No job needs write access; the
    breaking-change label is read from the event payload.
  - No check needs a secret. `scripts/ci-env.sh` writes `.env` from `.env.example` and
    replaces every placeholder password with a random throwaway value, so pull requests from
    forks run the full suite. Any future secret (for example a deploy key) comes only from
    GitHub Actions secrets and is never used by a pull-request job.
  - `.env.example` holds placeholders only (`change-me-…`). The gitleaks config doesn't
    allowlist real-looking values.
- **Rationale**: Clarification 1 and SC-008. The jobs run in parallel, so the total stays
  under 15 minutes.
- **Alternatives**: one sequential job (too slow for SC-008). The gitleaks GitHub Action
  instead of the container image: it needs a licence key for organisation accounts, and the
  image runs the same scanner with no key.

## R24. Repository ignore rules
- **Decision**: the first task adds the root `.gitignore`:
  - `.env`, `.env.*` (except `!.env.example`)
  - `node_modules/`, `dist/`, `build/`, `coverage/`
  - `playwright-report/`, `test-results/`, `*.tsbuildinfo`
  - `.vite/`, `.DS_Store`
- **Rationale**: FR-001. The user requires it before any `.env` exists.

## R25. Developer inner loop
- **Decision**: `npm run dev` gives fast feedback without giving up production behaviour:
  - **Backing services from compose**: `docker compose -f docker-compose.yml -f
    compose.dev.yaml up -d db migrate mailpit`. The override publishes the database on
    `127.0.0.1:5432` and Mailpit's SMTP on `127.0.0.1:1025`, loopback only, for the
    host-run processes. Nothing in the production-like `docker-compose.yml` changes.
  - **API with reload**: `tsx watch backend/src/server.ts` on the host. It reads `.env`
    through `scripts/dev-env.mjs`, which rewrites only the database and SMTP hosts to
    `127.0.0.1`. The same config validation runs, including credential separation:
    `dev-env` passes the API only `DATABASE_URL`.
  - **Web with HMR**: Vite's dev server on `http://localhost:8080`, the same port as
    production. It proxies `/api/` to the API exactly as nginx does, so the browser sees
    one origin and cookies behave the same.
  - **Same security headers**: the CSP and the other headers are defined once, in
    `deploy/security-headers.mjs`.
    - Vite's `server.headers` uses that module, and a test asserts nginx's config carries
      the identical values.
    - The one difference is a dev-only nonce for the inline React Refresh preamble
      (Vite `html.cspNonce`). It's added to `script-src` only in the dev server, and
      production and Playwright run the exact production policy.
  - `concurrently` runs both processes, and Ctrl-C stops both and leaves the compose
    services running.
  - **Tests locally need only Docker**: `npm test` starts its own PostgreSQL 17 through
    Testcontainers and doesn't use the dev database.
  - **Root scripts**:
    - `npm run dev`, `npm test`, `npm run lint`, `npm run typecheck`
    - `npm run e2e` (against `docker compose up`)
    - `npm run contract:generate`, `npm run check:ids`, `npm run check:bundle`,
      `npm run check:traceability`
  - `docker compose up` with `.env` remains the only **required** setup step. The dev loop
    is optional.
- **Rationale**: a reload in under a second for both apps, while same origin, cookies and
  the CSP stay the same as production. Without that, auth bugs (slice 1) would only show up
  in the compose stack.
- **Alternatives**: running the API and web inside containers with bind mounts and watch
  (slow file watching on macOS and Windows, `node_modules` conflicts); Vite on its default
  port 5173 with CORS (a different origin, so cookies and CSRF behave differently from
  production); nginx in front of Vite in dev (works, but one more moving part, when
  Vite's proxy and shared headers give the same result).
