# Implementation Plan: Slice 0 — Foundation

**Branch**: `001-foundation` | **Date**: 2026-10-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-foundation/spec.md`

## Summary

Build the platform every later slice stands on, with no procurement features:
- an optional developer inner loop (`npm run dev`: API reload, Vite HMR, same origin and
  headers as production)
- a one-command docker compose stack: db, migrate (role provisioning → migrations →
  bootstrap), api, web (nginx edge plus the React build), maintenance, and Mailpit under the
  `local` profile
- validated configuration
- structured, redacted logs with correlation ids, plus internal-only metrics
- health and readiness checks
- the RFC 9457 error format and its code registry
- three least-privilege database roles
- an audit table that the database protects through actor context
- the Zod → OpenAPI pipeline with drift and breaking-change checks
- the React shell with ConfirmDialog, page states and the unsaved-changes guard
- the after-commit mail adapter
- the admin bootstrap and `admin:create`
- the daily purge
- GitHub Actions CI covering every check, safe for a public repository (no
  `pull_request_target`, no secrets needed, gitleaks)

The technical choices are in [research.md](research.md). They follow ADR-0003, 0006, 0007,
0008, 0013, 0016, 0017, 0018 and 0020.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict`) on Node.js 24 LTS; SQL for PostgreSQL 17

**Primary Dependencies**:
- API: Express 5, Prisma, Zod 4, zod-openapi, pino and pino-http, prom-client, helmet,
  nodemailer
- Web: React 19, Vite, React Router 7 (data router), TanStack Query 5, React Aria
  Components, openapi-fetch and openapi-typescript

**Storage**: PostgreSQL 17, with roles `po_owner`, `po_app` and `po_maintenance`

**Testing**:
- API: Vitest, Supertest, Testcontainers (PostgreSQL 17)
- Web: Vitest, Testing Library, vitest-axe, MSW
- End to end: Playwright with `@axe-core/playwright`
- Checks: oasdiff, commitlint, custom Node check scripts

**Target Platform**: Linux containers via docker compose. Browsers: the latest 2 versions of
Chrome, Edge, Firefox and Safari.

**Project Type**: web application (API + SPA), in npm workspaces

**Performance Goals**:
- web shell within the bundle budget (entry ≤ 200 KB gzip; each route chunk ≤ 150 KB)
- CI wall time under 15 minutes (SC-008)
- a clean start under 10 minutes (SC-001)

**Constraints**:
- same origin only
- no secrets, tokens or personal data in logs, except the one-time links
- metrics never reachable from the host
- strict CSP with no inline scripts
- each process holds only its own database credentials
- public repository: CI needs no secrets, never uses `pull_request_target`, and
  `.env.example` holds placeholders only

**Scale/Scope**: 6 compose services (db, migrate, api, web, maintenance, mailpit), 3 tables, 2 public endpoints, 1 CLI command,
1 shell screen plus the demo route, and 7 CI jobs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this slice complies | Status |
|---|---|---|
| I. Derived-value integrity | No derived values yet. Lays the groundwork: least-privilege app role (can't write protected columns, can't disable triggers, can't update or delete audit), a reconciliation query file wired into CI (returns 0 rows), and raw-SQL migrations for triggers and grants | Pass |
| II. State machine | No orders in this slice | N/A |
| III. Authorization | Deny by default: every route declares `access`, enforced at startup and in CI. Only `public` health routes exist. A route-table test proves no HTTP path reaches the CLI or `/metrics` on the public app. Admins come only from the bootstrap and the CLI | Pass |
| IV. Audit | Audit table with actor `CHECK`, actor-context trigger, append-only grants, written in the change's transaction, `OPERATOR` and `SYSTEM` actors, and retention purge under the maintenance role | Pass |
| V. Concurrency | `withTransaction`: explicit timeouts, retry of `40001`/`40P01`, `503` on pool exhaustion or timeout, after-commit hooks. Advisory locks for bootstrap, CLI and purge | Pass |
| VI. API contract | Zod single source, generated committed OpenAPI, drift and oasdiff checks, problem+json, one registry, no `422`, strict schemas, central DB error mapping | Pass |
| VII. Performance | No lists yet. Bundle budget is enforced. The query-plan tooling arrives with the first list (slice 1) | Pass |
| VIII. Test-first, real PostgreSQL | Tests written first for every story; Testcontainers PostgreSQL 17 with the production provisioning; no database mocks; injected clocks for the purge | Pass |
| IX. Operability and security | Single `docker compose up`; config validation with production refusals; redacted structured logs; correlation ids; health and readiness; internal metrics; security headers; CSP; maintenance role separation | Pass |
| X. Brief binding | Covers brief §6 "`docker compose up` + `.env`". Every requirement traces to `docs/traceability.md`. ADR updates recorded (below) | Pass |
| XI. Code clarity | `strict` TS, ESLint, Prettier; layering routes → services → repositories; requirement-ID ban script and commitlint rule | Pass |
| XII. Simplicity | npm workspaces (no extra build tool); one nginx container for both static files and the edge; no metrics server; plain Node check scripts; no services beyond ADR-0020's list | Pass |
| XIII. Frontend | Generated client, code-based error map, page states, ConfirmDialog to the confirmation rule, unsaved-changes guard, WCAG 2.1 AA via axe, strict CSP, bundle budget in CI | Pass |

**Gate result (pre-research)**: PASS. No violations, so Complexity Tracking stays empty.

**Re-check after Phase 1 design**: PASS. The design adds no service, dependency or pattern
outside the ADRs, apart from these three recorded ADR updates:
1. ADR-0007: `413 PAYLOAD_TOO_LARGE`, and the field codes `MALFORMED_JSON` and
   `UNSUPPORTED_MEDIA_TYPE` (research R4).
2. ADR-0016: `ADMIN_CREATED` may have actor `SYSTEM` for the bootstrap, with
   `details.source` (research R13).
3. ADR-0018: component library chosen, React Aria Components (research R17).

These are decision-gate updates, not deviations.

## Project Structure

### Documentation (this feature)

```text
specs/001-foundation/
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1: openapi.yaml, errors.md, config.md, cli.md, metrics.md, ui-components.md
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
.gitignore                         # first task, before any .env exists
.env.example
docker-compose.yml                 # production-like stack (the only required setup)
compose.dev.yaml                   # dev override: db and Mailpit SMTP on 127.0.0.1 for host-run processes
.gitleaks.toml
package.json                       # npm workspaces + root scripts (dev, test, lint, typecheck, e2e, check:*)
tsconfig.base.json
eslint.config.mjs
commitlint.config.mjs
.github/workflows/
├── ci.yml                         # static, api, contract, web, audit, e2e, traceability, secrets; pull_request + push only
└── nightly.yml                    # Playwright on Chromium, Firefox, WebKit
deploy/
├── api.Dockerfile                 # used by migrate, api, maintenance
├── web.Dockerfile                 # builds apps/web, serves it with nginx
├── security-headers.mjs           # single source of the CSP and headers (nginx + Vite dev server)
└── nginx/default.conf             # /api/ proxy, /metrics 404, CSP and security headers
scripts/
├── check-requirement-ids.mjs
├── requirement-id-allowlist.txt
├── check-traceability.mjs
├── check-bundle-budget.mjs
├── ci-env.sh                      # .env from .env.example with random throwaway secrets
├── dev-env.mjs                    # .env for host-run dev processes (hosts → 127.0.0.1)
└── smoke.sh                       # health, readiness, web, maintenance first run, metrics exposure
apps/api/
├── prisma/
│   ├── schema.prisma
│   └── migrations/                # raw SQL: tables, CHECKs, triggers, functions, grants
├── db-init/roles.sql              # idempotent role creation (run as superuser)
├── src/
│   ├── config/                    # Zod schemas per process
│   ├── observability/             # logger (redaction), correlation id, metrics listener
│   ├── http/
│   │   ├── app.ts
│   │   ├── define-route.ts        # access + schemas + OpenAPI registration
│   │   ├── middleware/            # correlation, security headers, origin check, body limit, errors
│   │   └── routes/health.ts       # /healthz, /readyz
│   ├── db/
│   │   ├── client.ts
│   │   ├── transaction.ts         # withTransaction, actor context, retries, afterCommit
│   │   ├── errors.ts              # the only DB/ORM error mapper
│   │   ├── locks.ts               # ADMIN_LOCK, PURGE_LOCK
│   │   └── reconciliation.sql
│   ├── audit/                     # audit writer (typed events)
│   ├── users/                     # minimal repository for bootstrap and CLI
│   ├── tokens/                    # one-time token create (hash) and supersede
│   ├── mail/                      # Mailer interface, SmtpMailer, CaptureMailer
│   ├── bootstrap/run.ts           # migrate step 3
│   ├── cli/
│   │   ├── admin.ts               # command runner
│   │   └── commands/admin-create.ts
│   ├── maintenance/
│   │   ├── purge.ts
│   │   └── loop.ts
│   └── migrate/run.ts             # db-init → prisma migrate deploy → bootstrap
└── tests/
    ├── unit/
    ├── integration/               # roles, audit, errors, transaction, bootstrap, CLI, purge, mail, config
    └── contract/                  # responses vs committed OpenAPI
apps/web/
├── src/
│   ├── app/                       # router (data router), providers, shell layout
│   ├── api/                       # generated types + openapi-fetch client
│   ├── components/                # ConfirmDialog, Loading, Empty, ErrorState, RouteErrorBoundary
│   ├── hooks/                     # useUnsavedChangesGuard, useQueryStates
│   ├── errors/                    # code → message map
│   └── pages/                     # Home, NotFound, __demo (development only)
├── tests/                         # Vitest + Testing Library + vitest-axe
└── e2e/                           # Playwright + axe
packages/contracts/
├── src/
│   ├── errors.ts                  # the registry
│   ├── schemas/                   # Zod: problem, health, readiness
│   └── openapi.ts                 # generator
└── openapi/openapi.json           # generated, committed
```

**Structure Decision**: a web application split into `apps/api`, `apps/web` and
`packages/contracts`, in npm workspaces (research R2). The contract package is the single
source shared by both apps (ADR-0008). Deployment files live in `deploy/`, and check
scripts in `scripts/`.

## Phase notes for `/speckit-tasks`

- **Task ordering**:
  1. The first task is the root `.gitignore` (FR-001), before `.env.example` or any `.env`
     exists.
  2. Then workspace scaffolding and the CI skeleton, so every following task lands under
     the checks.
- **Tests first** for each story:
  - roles and audit (Story 4) and errors (Story 3) before their middleware and SQL
  - the bootstrap and CLI tests before the commands
- **Final task**: enable branch protection on `main`, requiring every `ci.yml` job
  (`static`, `api`, `contract`, `web`, `audit`, `e2e`, `traceability`, `secrets`). This is
  a manual GitHub settings step, done once CI is green on this branch. The task records
  who did it and when.
- **Docs updates in this slice**:
  - the three ADR updates listed above
  - `CLAUDE.md` commands, once the scripts exist
  - `docs/traceability.md` statuses moved forward as tests land

## Complexity Tracking

No Constitution Check violations. Nothing to justify.
