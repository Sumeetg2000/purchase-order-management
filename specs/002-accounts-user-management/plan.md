# Implementation Plan: Slice 1 — Accounts and user management

**Branch**: `002-accounts-user-management` | **Date**: 2026-11-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-accounts-user-management/spec.md`

## Summary

Give the product real, authenticated users (brief §6) on the slice 0 platform:
- restricted signup, email verification and a no-role start, with in-app access requests
- login with ADR-0017's ordered specific codes, per-account lockout and PostgreSQL-backed
  rate limits
- cookie sessions: a 15-minute JWT access cookie, rotating refresh tokens with reuse
  detection and the 10-second sibling window, 7-day idle and 30-day absolute limits, CSRF
- logout, logout-all, session list and revoke; change, forgot and reset password
- `/me` profile; admin user management and access requests; operator
  `admin:deactivate`/`admin:reactivate`
- security logs, and the purge of ended sessions and rate-limit windows
- the web app's auth flow, account pages, Access pending, Profile and admin Users

Choices the ADRs leave open are in [research.md](research.md) (R1–R21), tables in
[data-model.md](data-model.md), and the reviewed Zod schemas and OpenAPI diff in
[contracts/api.md](contracts/api.md).

## Technical Context

**Language/Version**: TypeScript 6 (`strict`) on Node.js 24; SQL for PostgreSQL 17

**Primary Dependencies**: slice 0's stack, plus `argon2` 0.45.1, `jose` 6.2.12 and
`cookie` 2.0.1, all backend-only (R21). No frontend dependency.

**Storage**: PostgreSQL 17. New tables `sessions`, `refresh_tokens`, `access_requests`,
`rate_limit_counters`; `users` completed (migrations 0007–0010).

**Testing**: Vitest + Supertest + Testcontainers PostgreSQL 17 (no DB mocks; injected
clock), Testing Library + vitest-axe + MSW, Playwright + axe (Mailpit API for email).

**Target Platform**: the slice 0 docker compose stack; no new service.

**Project Type**: web application (API + SPA), npm workspaces.

**Performance Goals**: `LIMIT`ed, indexed admin lists (their 10,000-user plans and SC-008
move to slice 7, owner decision 2026-11-03); login under ~100 ms server time with the argon2id profile (R3); every new
route chunk ≤ 150 KB gzip.

**Constraints**: no token in any body or JS-readable storage; no token or password
in logs (two set-password links excepted); no phone stored (POC scope, 2026-11-03);
strict schemas everywhere; deny by default; no anti-enumeration (owner decision
2026-11-02); no infrastructure beyond ADR-0020.

**Scale/Scope**: 22 operations, 4 tables (+ `users` columns), 2 CLI commands, 2 purge
tasks, 25 error codes + 6 field codes, 9 screens, 8 dialogs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this slice complies | Status |
|---|---|---|
| I. Derived-value integrity | No derived values. Least-privilege grants per new table; counters, lockout and sessions change only through repository statements | Pass |
| II. State machine | No orders. User status and access-request transitions are `CHECK`-guarded (data-model) | N/A |
| III. Authorization | Access level on every operation (R1), enforced before validation; `NO_ROLE_ASSIGNED` precedence; matrix generated from the route table × 6 caller kinds; admins only via bootstrap/CLI | Pass |
| IV. Audit | Ten user events in the change's transaction, `SELF`/`ADMIN`/`OPERATOR` actors; auth events are security logs, not audit | Pass |
| V. Concurrency | Refresh under row lock (R5), atomic lockout and counter statements (R8, R9), `If-Match` on admin updates (R14), `ADMIN_LOCK` for the CLI | Pass |
| VI. API contract | Zod single source, strict bodies at every depth, body inventory updated, registry + message map complete, additive OpenAPI diff | Pass |
| VII. Performance | First lists: `LIMIT`ed SQL, filters in SQL, matching indexes (R13). Their committed `EXPLAIN` at 10k users is deferred to slice 7 (deviation ADR-0021, Complexity Tracking) | Deviation recorded |
| VIII. Test-first, real PostgreSQL | Each story's tests written first and seen failing against Testcontainers; injected clock for every time rule; barriers for concurrent refresh and CLI | Pass |
| IX. Operability and security | New secrets validated and refused as placeholders in production; argon2id; HttpOnly SameSite=Strict cookies; CSRF; security log; 90-day purge (DPDP) | Pass |
| X. Brief binding | §6 "every action tied to a real, authenticated user"; every FR traces to a traceability row; ADR-0017 amended for FR-016; no permission change beyond the signed-off ADR-0016 | Pass |
| XI. Code clarity | Layering per area (below); named constants for every lifetime, limit and retention; codes as const-list unions | Pass |
| XII. Simplicity | Rate limits in the existing database (no Redis), one key (no key ring), fixed windows, raw SQL only where Prisma can't express it | Pass |
| XIII. Frontend | Generated client, refresh only on `ACCESS_TOKEN_EXPIRED`, single-flight per tab (the sibling window covers several tabs), ConfirmDialog per ADR-0018, page states, axe | Pass |

**Gate result (pre-research)**: PASS.

**Re-check after Phase 1 design**: PASS. Two documentation updates, no deviation:
1. ADR-0017 (2026-11-02, owner decision): rate-limit counters always in PostgreSQL; its
   test list and the `NFR-SEC-05` traceability row follow.
3. 2026-11-03, POC scope, owner decision (ADR-0004, 0007, 0016, 0017, 0018, 0020
   amended): no phone field, so no phone purge, phone-leak scans, `INVALID_PHONE` or
   `libphonenumber-js`; no cross-tab refresh coordination; no 10,000-user seed or
   committed plans for the admin lists in this slice; resend-verification and
   forgot-password limited per email only. `NFR-PRIV-02` withdrawn.
2. ADR-0016 says "`400 VERSION_REQUIRED`"; the design keeps ADR-0007's form, a field code
   of `VALIDATION_FAILED` (R14). Same status, same code string, so no ADR change.

## Project Structure

### Documentation (this feature)

```text
specs/002-accounts-user-management/
├── spec.md, checklists/requirements.md
├── plan.md            # this file
├── research.md        # R1–R21
├── data-model.md      # migrations 0007–0010, audit events
├── quickstart.md
├── contracts/         # api.md (Zod + operations + OpenAPI diff), errors.md, config.md, cli.md, ui.md
└── tasks.md           # /speckit-tasks
```

### Source Code (new and changed)

Layering per CLAUDE.md: `routes.ts` maps HTTP to service calls; `service.ts` opens
`withTransaction` and owns rules; `repository.ts` alone runs queries. Pure helpers (no
DB) sit beside them.

```text
packages/contracts/src/
├── operations.ts            # +22 operations, ACCESS_LEVELS, ifMatch flag
├── errors.ts                # +25 codes, +6 field codes, Problem.reason
├── users.ts                 # ASSIGNABLE_ROLE_SETS, password and name limits, ACTING_ROLES
└── schemas/                 # pagination, ids, auth, me, sessions, access-requests, admin-users
packages/contracts/tests/body-inventory.test.ts   # EXPECTED grows

backend/prisma/migrations/0007_user_accounts … 0010_rate_limits
backend/src/
├── lib/clock.ts
├── http/
│   ├── middleware/authorize.ts     # access level → 401/403, CSRF; calls auth/service
│   ├── define-route.ts             # custom field codes (R4), If-Match parsing (R14)
│   └── routes/index.ts             # registers the new areas
├── auth/                           # login, refresh, logout(-all), sessions, change-password
│   ├── routes.ts  service.ts  repository.ts   # repository: sessions, refresh_tokens
│   ├── cookies.ts  access-token.ts  csrf.ts   # pure: names, flags, jose, HMAC
│   ├── passwords.ts  common-passwords.txt     # argon2id, policy, the list
│   └── constants.ts                           # lifetimes, grace, lockout numbers
├── accounts/                       # signup, verify, resend, forgot, reset
│   └── routes.ts  service.ts                  # uses users/ and tokens/ repositories
├── profile/                        # GET/PATCH /me, own access request
│   └── routes.ts  service.ts
├── admin-users/                    # users list/detail/update/reset, access-request list/dismiss
│   └── routes.ts  service.ts
├── users/repository.ts             # + profile, roles/status, lockout, list queries
├── access-requests/repository.ts
├── rate-limit/
│   ├── buckets.ts                  # the const bucket list with limits and windows
│   ├── service.ts  repository.ts
├── audit/events.ts                 # + the eleven user events
├── observability/security-log.ts   # + the account events (R18)
├── mail/templates/                 # verify-email, reset-password, admin-reset-password
├── cli/commands/admin-deactivate.ts, admin-reactivate.ts
├── maintenance/purge.ts, registry.ts   # sessions, rate_limit_counters tasks
├── migrate/seed-demo.ts            # two Buyers and one Approver when SEED_DEMO_DATA=true
└── config/api.ts                   # SIGNUP_ALLOWED_DOMAINS, JWT_SIGNING_KEY, JWT_KEY_ID, CSRF_SECRET
backend/tests/
├── integration/   # accounts, login-lockout, rate-limit, sessions-refresh, csrf, profile,
│                  # access-requests, admin-users, authorization-matrix, cli-admin-status,
│                  # purge (extended), security-log
└── unit/          # passwords, cookies, access-token, csrf, buckets

frontend/src/
├── auth/          # AuthProvider, refreshSession, client middleware, RequireUser, RequireRole, useFragmentToken
├── pages/account/ # Login, Signup, VerifyEmail, ForgotPassword, ResetPassword
├── pages/AccessPending.tsx
├── pages/profile/ # Profile, ChangePasswordForm, SessionsList
├── pages/admin/   # Users, AccessRequests, RoleDialog, user action dialogs
├── errors/messages.ts               # + every new code
└── app/router.tsx, Shell.tsx        # routes, guards, nav badge
frontend/e2e/      # auth-refresh, logout, signup-to-buyer, dismissal, forgot-reset, profile-sessions, admin-users
```

**Structure Decision**: one backend folder per area, each with its own `routes.ts` and
`service.ts`; repositories are per table (`users/`, `access-requests/`, `auth/` for
sessions, `rate-limit/`) and shared by the services that need them. Routes never import
a repository, Prisma or `db/transaction.ts`; the lint rule already enforces this for
`routes.ts`.

## Story order for `/speckit-tasks`

0. **Foundational** (blocks every story): migrations 0007–0010 and grants, contracts
   (access levels, codes, schemas, inventory), config secrets, `Clock`, the authorize
   step with CSRF, password policy and hashing, the rate limiter, the security-log
   events, the frontend client middleware and `AuthProvider` shell.
1. **US1 Log in, stay logged in, log out**: login, refresh, logout, logout-all,
   `GET /me`, and `reset-password` (needed for the bootstrap set-password link); Login and
   Reset/Set-password pages, silent refresh. Demonstrable alone with the bootstrap admin.
2. **US2 Sign up, verify, access request**: signup, verify, resend, own access request,
   Access pending; `NO_ROLE_ASSIGNED` routing.
3. **US3 Administer users and access requests**: admin endpoints, Users screen, dialogs,
   badge, demo seed.
4. **US4 Profile, password, sessions**: `PATCH /me`, change-password, sessions list and
   revoke, Profile page.
5. **US5 Forgot and reset**: forgot-password, admin-reset email wording, remaining rate
   limit tests (reset itself landed in US1).
6. **US6 Operator CLI**: `admin:deactivate`, `admin:reactivate`.
7. **US7 Retention and security records**: purge tasks, security-log scan.
8. **Polish**: authorization matrix over every operation × 6 caller kinds, e2e specs,
   traceability rows, quickstart run, docs.

Each story: tests first, seen failing against real PostgreSQL, then code; a short
summary stop after each story.

## Phase notes for `/speckit-tasks`

- The first PR of this slice (the draft opened with this plan) carries the owed T114
  breaking-change self-test: a throwaway `selftest/breaking` draft PR whose run is
  recorded in `specs/001-foundation/ci-selftest.md`.
- `LEFTHOOK_EXCLUDE=eslint` only for test-first commits that import code not yet written.
- Docs touched by the slice: `docs/traceability.md` statuses, `CLAUDE.md` (no change
  expected), `.env.example`, quickstart results.

## Complexity Tracking

| Deferral | Why | Where it is paid |
|---|---|---|
| Principle VII: committed query plans (page and `COUNT`) for the admin users and access-request lists | POC scope, owner decision 2026-11-03: a 10,000-user seed and plan tooling for two admin lists cost more here than they prove; the indexes ship now | Slice 7, with the other load tests and query plans. Deviation ADR-0021 (revisit: slice 7 commits both plans) |
