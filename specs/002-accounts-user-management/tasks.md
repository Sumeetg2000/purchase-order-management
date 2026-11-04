---

description: "Task list for Slice 1 — Accounts and user management"
---

# Tasks: Slice 1 — Accounts and user management

**Input**: Design documents from `specs/002-accounts-user-management/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Required (Principle VIII). Every test task is **run and seen failing against
real PostgreSQL** (Testcontainers) before the task that makes it pass; its commit body
carries a "Failing run:" line under 100 characters. Time rules use the injected `Clock`.
Requirement IDs go in test names only (ADR-0013).

**Organization**: Setup, Foundational, then US1–US7 in plan order, then Polish. Stories
run in sequence; each ends with a checkpoint (review + green CI on draft PR #13) and a
short summary stop.

## Format: `- [ ] T### [P?] [US#?] Outcome — files — refs`

- **[P]**: parallel with the other [P] tasks of the same group (different files, no
  dependency on an incomplete task).
- **Refs**: spec FR/SC and the `docs/traceability.md` row ID the tests carry.
- **Size**: one reviewable commit each, roughly under 300 changed lines.
- **Layering**: `routes.ts` → `service.ts` → `repository.ts`; routes never import Prisma,
  a repository or `db/transaction.ts`.
- **While working**: run only the affected tests; the full gate before each push.

---

## Phase 1: Setup

- [X] T001 Add `argon2` 0.45.1, `jose` 6.2.12 and `cookie` 2.0.1, exact, to the backend
  only — `backend/package.json`, `package-lock.json` — R21.
  `npm audit --audit-level=high` still exits 0.
- [X] T002 [P] Config: `SIGNUP_ALLOWED_DOMAINS`, `JWT_SIGNING_KEY`, `JWT_KEY_ID`,
  `CSRF_SECRET` with the rules in [contracts/config.md](contracts/config.md) (placeholders
  refused in production, `CSRF_SECRET ≠ JWT_SIGNING_KEY`, secrets redacted and never
  echoed); tests first in `backend/tests/unit/config.test.ts` —
  `backend/src/config/api.ts`, `.env.example`, `scripts/ci-env.sh`, `scripts/dev-env.mjs`
  — FR-031, NFR-SEC-01.
- [X] T003 [P] Bundle the common-password list (NCSC 100k from SecLists, entries of
  12–128 characters, lower-cased, header naming the source); a test pins its line count
  and SHA-256 — `backend/src/auth/common-passwords.txt`,
  `backend/tests/unit/passwords.test.ts` — R4, FR-014.

---

## Phase 2: Foundational (blocks every story)

### Schema

- [X] T004 Tests: migrations 0007–0010 per [data-model.md](data-model.md) — every column,
  `CHECK` (`failed_login_count BETWEEN 0 AND 4`, no `phone` column,
  `(revoked_at IS NULL) = (revoke_reason IS NULL)`, `octet_length(token_hash) = 32`,
  `char_length(message) BETWEEN 1 AND 500`, `(status = 'OPEN') = (decided_at IS NULL)`,
  `hits >= 1`, bucket names), index and grant; each SQL copy of a constant
  (`SESSION_REVOKE_REASONS`, access-request statuses, bucket names, lengths) pinned to it;
  `schema.prisma` diff clean — `backend/tests/integration/migrations.test.ts`,
  `backend/tests/integration/roles.test.ts` — FR-028, FR-030.
- [X] T005 Migrations `0007_user_accounts`, `0008_sessions`, `0009_access_requests`,
  `0010_rate_limits` and the matching `schema.prisma` models — `backend/prisma/` — T004
  green.

### Contracts

- [X] T006 Tests: registry has the 25 codes and 6 field codes of
  [contracts/errors.md](contracts/errors.md) with their statuses; `Problem.reason` is
  optional, a `PublicRevokeReason` (`PASSWORD_CHANGED`, `PASSWORD_RESET`,
  `ROLES_CHANGED` only), and allowed only on `SESSION_REVOKED`; the web message map and
  the public-reason map are complete `Record`s, and a `SESSION_REVOKED` without a
  `reason` maps to the generic logged-out message —
  `packages/contracts/tests/errors.test.ts`, `frontend/src/errors/messages.test.ts` —
  FR-031, FR-ACC-03, SC-003, NFR-FE-02.
- [X] T007 Registry, field codes, `Problem.reason`, the public enum
  `PUBLIC_REVOKE_REASONS` (`PASSWORD_CHANGED`, `PASSWORD_RESET`, `ROLES_CHANGED`),
  `ACCESS_LEVELS`, `ACTING_ROLES` (+`SELF`), password and name limits, and the web
  messages: the four token codes, "You were logged out because <reason>. Please log in
  again." for a public reason, and "You've been logged out. Please log in again." for a
  `SESSION_REVOKED` without one. The full `SESSION_REVOKE_REASONS` (all eight, built from
  the public three) stays backend-only in T013's `auth/constants.ts` — `packages/contracts/src/errors.ts`, `schemas/problem.ts`,
  `users.ts`, `frontend/src/errors/messages.ts` — T006 green.
- [X] T008 Tests: the slice 1 request and response schemas of
  [contracts/api.md](contracts/api.md) (strict bodies, password field codes, pagination,
  list queries, role sets), `ACCESS_LEVELS`, and the generator's per-access-level security
  schemes and `If-Match` header, using made-up operations —
  `packages/contracts/tests/account-schemas.test.ts`, `tests/openapi.test.ts` — FR-032,
  NFR-VAL-01.
- [X] T009 Zod schemas, the five access levels, the `ifMatch` flag, and the generator's
  security schemes and `If-Match` header — `packages/contracts/src/schemas/*`,
  `operations.ts`, `openapi.ts` — T008 green. The 22 operations themselves join
  `OPERATIONS`, the body inventory and the OpenAPI document **with their routes, story by
  story**: a test requires the served routes to equal the contract's operations, so
  adding them all here would leave documented operations unserved (decided while
  implementing, 2026-11-03).

### Platform

- [X] T010 [P] Remove slice 0's phone leftovers (no phone is stored, ADR-0016 amended
  2026-11-03): delete the `PHONE_KEY` check, `phoneKeyPath` and
  `ForbiddenAuditDetailError` from `backend/src/audit/write.ts`, the `NoPhone` type from
  `backend/src/audit/events.ts`, and their test file
  `backend/tests/unit/audit-details.test.ts`; reword the `PURGE_TABLES` comment in
  `backend/src/maintenance/purge.ts` (slice 1 adds sessions and rate-limit windows,
  slice 3 idempotency keys); keep `phone` in the logger's redaction pattern
  (`backend/src/observability/logger.ts`) — NFR-PRIV-01. The remaining `NFR-PRIV-01`
  tests (log redaction) still pass.
- [X] T011 [P] Injected `Clock` (system and test clocks), threaded through the app
  factory — `backend/src/lib/clock.ts`, `backend/src/http/app.ts`.
- [X] T012 [P] Unit tests: password policy field codes (`PASSWORD_TOO_SHORT`/`_LONG`/
  `_COMMON`), argon2id profile (19 MiB, t=2, p=1), cookie names, flags and paths
  (`po_access` `/api`, `po_refresh` `/api/auth`, `po_csrf`; HttpOnly except CSRF,
  Secure, SameSite=Strict, `Max-Age`), access token (HS256, `kid`, `sid`, 15 min,
  expired vs malformed), CSRF HMAC of the session id —
  `backend/tests/unit/{passwords,cookies,access-token,csrf}.test.ts` — NFR-SEC-01,
  NFR-SEC-04, NFR-SEC-05, FR-014.
- [X] T013 Implement them, every lifetime and limit a named constant —
  `backend/src/auth/{passwords,cookies,access-token,csrf,constants}.ts` — T012 green.
- [X] T014 Tests: one-time token consume returns used → superseded → expired → unknown in
  that order (`TOKEN_USED`, `TOKEN_SUPERSEDED`, `TOKEN_EXPIRED`, `INVALID_TOKEN`); wrong
  purpose and purged rows are unknown; a used and expired token is `TOKEN_USED`; a valid
  one is marked used once under `FOR UPDATE` (two concurrent consumes: one wins) —
  `backend/tests/integration/tokens.test.ts` — FR-ACC-03.
- [X] T015 `consumeToken(tx, purpose, token)` returning the outcome —
  `backend/src/tokens/one-time.ts` — T014 green.
- [X] T016 Tests: rate limiter — fixed window per bucket, the (N+1)th hit → `429
  RATE_LIMITED` with `Retry-After` to the window end, new window resets, two app
  instances on one database share the count, every bucket of ADR-0017 listed once —
  `backend/tests/integration/rate-limit.test.ts`, `backend/tests/unit/buckets.test.ts` —
  FR-005, FR-016, NFR-SEC-05.
- [X] T017 Buckets const list, repository (single upsert statement returning hits), and
  service — `backend/src/rate-limit/{buckets,repository,service}.ts` — T016 green.
- [X] T018 Tests: authorize step on a probe route table — no or bad token → `401
  UNAUTHENTICATED`, expired → `401 ACCESS_TOKEN_EXPIRED`, deactivated user → `401
  ACCOUNT_DEACTIVATED`, no role → `403 NO_ROLE_ASSIGNED` before body validation, wrong
  role → `403 FORBIDDEN`, missing/wrong CSRF or foreign `Origin` → `403 CSRF_REJECTED`,
  roles read per request; an operation without an access level fails at startup; missing
  `If-Match` → `VERSION_REQUIRED` field code — `backend/tests/integration/csrf.test.ts`,
  `backend/tests/integration/authorize.test.ts` — FR-007, FR-010, FR-017, SC-006, NFR-AUTH-01,
  NFR-SEC-04.
- [X] T019 Authorize middleware and `defineRoute` (access level, custom field codes,
  `If-Match` parsing) — `backend/src/http/middleware/authorize.ts`,
  `backend/src/http/define-route.ts`, `backend/src/http/routes/index.ts` — T018 green.
- [X] T020 [P] Security-log event names and writer for this slice's events (R18); a test
  asserts the field allow-list never carries a token or password —
  `backend/src/observability/security-log.ts`,
  `backend/tests/unit/security-log.test.ts` — FR-029, NFR-SEC-06.
- [X] T021 [P] Frontend client middleware: `X-CSRF-Token` from `po_csrf` on mutating
  calls, with the cookie and header names shared from `@po/contracts` —
  `frontend/src/api/client.ts`, `frontend/tests/csrf-middleware.test.ts` — FR-033. The
  `AuthProvider` over `GET /api/me` moves to T033, since `/me` joins the contract with its
  route in US1; tests inject `fetch` as the existing client tests do (no MSW dependency).

**Checkpoint**: T022 `/code-review` of Foundational; full gate; CI green on PR #13.

- [X] T022 Foundational checkpoint review and fixes.

---

## Phase 3: US1 — Log in, stay logged in, log out (P1) 🎯 MVP

**Goal**: the bootstrap admin sets a password from the set-password link, logs in, stays
logged in across access-token expiry, and logs out. **Independent test**: quickstart
steps 1–3 with only the bootstrap admin.

### Tests (seen failing)

- [X] T023 [P] [US1] Login: check order `ACCOUNT_NOT_FOUND` 404 → `ACCOUNT_LOCKED` 423 →
  `PASSWORD_NOT_SET` → `INCORRECT_PASSWORD` → `ACCOUNT_NOT_VERIFIED` →
  `ACCOUNT_DEACTIVATED` (401s); 5th wrong password locks for 15 min with `Retry-After`,
  right password while locked → 423, unlock after 15 min, success resets the counter,
  lockout holds across two instances; login rate limits (31st per IP, 11th per account
  per minute → 429); success sets 3 cookies, `last_login_at`, body is `me` with no token —
  `backend/tests/integration/login.test.ts` — FR-003, FR-004, FR-005, FR-006,
  NFR-SEC-01, NFR-SEC-05, NFR-SEC-07.
- [X] T024 [P] [US1] Refresh: rotation issues a new pair; reuse within 10 s → sibling,
  session stays valid; concurrent refreshes of one token both succeed (barrier); reuse
  after 10 s → whole session revoked (`REUSE_DETECTED` stored and logged), `401
  SESSION_REVOKED` with no `reason`; a session revoked for a public reason →
  `SESSION_REVOKED` with that `reason`, for `LOGOUT`/`LOGOUT_ALL`/`USER_REVOKED` → no
  `reason`; deactivated user →
  `ACCOUNT_DEACTIVATED` before the revoked check; idle 7 days and absolute 30 days →
  `SESSION_EXPIRED` (daily refresh still ends at 30 days, token expiry ≤ absolute); an
  8-hour working day never needs a login; CSRF cookie survives a simulated browser
  restart — `backend/tests/integration/sessions-refresh.test.ts` — FR-008, FR-009,
  SC-004, NFR-SEC-02, NFR-SEC-09, NFR-SEC-04.
- [X] T025 [P] [US1] Logout (even with an expired access token) revokes with `LOGOUT`;
  logout-all with `LOGOUT_ALL`; both clear cookies; refresh cookie never sent outside
  `/api/auth`; `GET /me` returns the FR-020 fields —
  `backend/tests/integration/logout.test.ts`, `profile.test.ts` — FR-011, FR-020,
  NFR-SEC-03.
- [X] T026 [P] [US1] Reset-password: the four token codes; a valid token sets the
  password (policy field codes), revokes every session with `PASSWORD_RESET`, clears the
  lockout, activates an `UNVERIFIED` user, writes `USER_EMAIL_VERIFIED` (`via: 'reset'`)
  when it does — `backend/tests/integration/reset-password.test.ts` — FR-015, FR-ACC-03,
  FR-ACC-05.

Amended after the US1 review (2026-11-03, owner decision): the access cookie lives as long
as the refresh cookie (its JWT still expires after 15 minutes); a refresh that fails with
no network or a 5xx keeps the session; and every request reads its session with its user,
so revocation takes effect on the next request (ADR-0017, ADR-0018). Covered by T035a.

- [X] T035a [US1] Review fixes: the access cookie's lifetime, refresh failures that keep
  the session, `parseProblem` in the refresh, and per-request session checks in
  `authenticate` with the web app ending the session on `SESSION_REVOKED` or
  `SESSION_EXPIRED` from any call — `backend/src/auth/`, `backend/src/users/`,
  `frontend/src/auth/refresh.ts` — NFR-SEC-02, NFR-SEC-03, NFR-FE-02.

### Implementation

- [X] T027 [US1] Users repository: find by email, login bookkeeping, atomic lockout
  `UPDATE` (`failed_login_count` 0–4, `locked_until`), set password —
  `backend/src/users/repository.ts`.
- [X] T028 [US1] Sessions repository: create session + first token, refresh under row
  lock (token then session), sibling insert, revoke one/all with reason —
  `backend/src/auth/repository.ts`.
- [X] T029 [US1] Auth service: login, refresh (R5 order), logout, logout-all, with
  security-log events; `SESSION_REVOKED` carries `reason` only when it is public —
  `backend/src/auth/service.ts` — T023–T025 green.
- [X] T030 [US1] Accounts service: reset-password via `consumeToken` —
  `backend/src/accounts/service.ts` — T026 green.
- [X] T031 [US1] Routes for login, refresh, logout, logout-all, reset-password, `GET /me`
  — `backend/src/{auth,accounts,profile}/routes.ts`, `profile/service.ts`.

### Frontend

- [X] T032 [P] [US1] Tests: refresh coordinator (only `ACCESS_TOKEN_EXPIRED` refreshes;
  single-flight within the tab, no cross-tab coordination; each queued request retries
  once; `SESSION_EXPIRED` → session-expired message, `SESSION_REVOKED` → the
  reason-specific message, both to `/login?returnTo=`); Login page per code; Reset /
  set-password page posts the fragment token once, clears it, shows each token code's
  message; axe clean — `frontend/src/auth/*.test.ts(x)`,
  `frontend/src/pages/account/*.test.tsx` — FR-033, FR-034, NFR-FE-02, NFR-FE-08.
- [X] T033 [US1] `AuthProvider` (current user from `GET /api/me`), `refreshSession`,
  `useFragmentToken`, `RequireUser`, Login and
  ResetPassword pages, router entries — `frontend/src/auth/`,
  `frontend/src/pages/account/`, `frontend/src/app/router.tsx` — T032 green.
- [X] T034 [US1] E2E: bootstrap set-password → login → silent refresh after access
  expiry → logout — `frontend/e2e/auth-refresh.spec.ts`, `logout.spec.ts` — FR-036.
- [X] T035 [US1] Checkpoint: `/code-review` + `/security-review`, fixes, CI green, stop.

---

## Phase 4: US2 — Sign up, verify, ask for access (P1)

**Goal**: a new employee signs up, verifies, logs in with no role and sends an access
request. **Independent test**: quickstart step 4 up to the Access pending screen.

- [X] T036 [P] [US2] Tests: signup (strict body, `roles` → 400, allowed domains
  case-insensitive, `SIGNUP_DOMAIN_NOT_ALLOWED`, `EMAIL_IN_USE` with nothing sent, new
  user `UNVERIFIED` with `{}`, `USER_SIGNED_UP`), verify (the four token codes, `ACTIVE`,
  not logged in, `USER_EMAIL_VERIFIED`), resend (new link supersedes the old;
  `ACCOUNT_NOT_FOUND`, `ACCOUNT_ALREADY_VERIFIED`, `ACCOUNT_DEACTIVATED`, nothing sent),
  signup rate limits per IP and per email, resend per email only (no per-IP limit);
  mail only after commit —
  `backend/tests/integration/accounts.test.ts` — FR-001, FR-002, FR-ACC-01, FR-ACC-02,
  NFR-SEC-08.
- [X] T037 [P] [US2] Tests: access request (no-role only, else `403 FORBIDDEN`; first send
  `OPEN`, second updates the message, one row; 4th in a day → 429; `GET` 404 when none;
  new request after dismissal; `ACCESS_REQUESTED`); a no-role user gets `403
  NO_ROLE_ASSIGNED` on every other non-public route, before body validation —
  `backend/tests/integration/access-requests.test.ts` — FR-018, FR-022, FR-ACC-08,
  FR-ACC-09.
- [X] T038 [US2] Verify-email mail template; accounts service signup, verify, resend —
  `backend/src/mail/template.ts`, `backend/src/accounts/{service,routes}.ts` — T036 green.
- [X] T039 [US2] Access-requests repository; profile service and routes for own request
  — `backend/src/access-requests/repository.ts`, `backend/src/profile/` — T037 green.
- [X] T040 [P] [US2] Frontend tests then Signup, VerifyEmail (token codes, resend on
  `TOKEN_EXPIRED`), AccessPending pages; `NO_ROLE_ASSIGNED` routing; axe —
  `frontend/src/pages/account/`, `frontend/src/pages/AccessPending.tsx` — FR-034,
  NFR-FE-08.
- [X] T041 [US2] E2E: signup → Mailpit link → verify → login → Access pending → send
  request — `frontend/e2e/signup-to-buyer.spec.ts` (first half) — FR-036, SC-001.
- [X] T042 [US2] Checkpoint: `/code-review` + `/security-review`, fixes, CI green, stop.

---

## Phase 5: US3 — Administer users and access requests (P1)

**Goal**: an admin lists users, assigns roles, deactivates and reactivates, sends a
reset, and handles access requests. **Independent test**: quickstart step 5.

- [X] T043 [P] [US3] Tests: list (role incl. none, status, `q` prefix on name/email
  case-insensitive, page boundaries, `name, id` stability, `lastLoginAt`); detail with
  `ETag` (open-order counts deferred to the orders slice, ADR-0019, 2026-11-04); update guards (`SELF_MODIFICATION`,
  `ADMIN_NOT_MODIFIABLE`, `USER_UNVERIFIED`, `INVALID_ROLE_SET`, other fields → 400,
  missing/stale `If-Match`), no-op writes nothing; role change and deactivation revoke
  sessions with `ROLES_CHANGED` / `DEACTIVATED`; the user's next refresh gets
  `SESSION_REVOKED` with `reason: ROLES_CHANGED`, or `ACCOUNT_DEACTIVATED`; deactivation dismisses the open request; role assignment resolves it in the
  same transaction; audit payloads — `backend/tests/integration/admin-users.test.ts` —
  FR-013, FR-023, FR-024, FR-ACC-07, FR-ADM-01, FR-ADM-02, NFR-AUD-04, NFR-SEC-03.
- [X] T044 [P] [US3] Tests: admin reset (unverified or active → 202, deactivated → 409
  `USER_DEACTIVATED` with nothing sent, 2026-11-04; standard email,
  `USER_PASSWORD_RESET_SENT`, never a token in the response); access-request list
  (status filter, `updatedAt DESC, id DESC`) and dismiss (note, `ACCESS_REQUEST_NOT_OPEN`)
  — `backend/tests/integration/admin-access.test.ts` — FR-025, FR-026, FR-ADM-03,
  FR-ADM-06.
- [X] T045 [US3] Users repository list/detail/update queries; admin-users service and
  routes; admin-reset template — `backend/src/users/repository.ts`,
  `backend/src/admin-users/`, `backend/src/mail/template.ts` — T043, T044 green.
- [X] T046 [US3] Demo seed: two Buyers and one Approver with `DEMO_PASSWORD`, never in
  production; test first — `backend/src/migrate/seed-demo.ts` — FR-037.
- [X] T047 [P] [US3] Frontend tests then Users list (filters in URL), AccessRequests tab,
  RoleDialog and user action dialogs (ADR-0018 wording), nav badge (60 s, focus, after
  actions), `RequireRole`; axe — `frontend/src/pages/admin/`, `frontend/src/app/Shell.tsx`
  — FR-034, FR-035, NFR-FE-08.
- [X] T048 [US3] E2E: assign a role from a request (second half of signup-to-buyer),
  dismissal shown to the user, admin users actions —
  `frontend/e2e/{signup-to-buyer,dismissal,admin-users}.spec.ts` — FR-036, SC-002.
- [X] T049 [US3] Checkpoint: `/code-review` + `/security-review`, fixes, CI green, stop.

---

## Phase 6: US4 — Profile, password and sessions (P2)

**Goal**: a user edits their name, changes password and manages sessions.
**Independent test**: quickstart step 6.

- [X] T050 [P] [US4] Tests: `PATCH /me` (name only; `phone` or any other field →
  `UNKNOWN_FIELD`; `USER_PROFILE_UPDATED` with name before and after); change
  password (policy codes, wrong current → field `INCORRECT_PASSWORD`, counted and locked
  like login, revokes other sessions with `PASSWORD_CHANGED`, keeps the current one);
  sessions list (own only, `current`, paginated, sorted) and revoke (`USER_REVOKED`
  stored, the revoked session's refresh gets no `reason`; another user's id → 404, current → cookies cleared) —
  `backend/tests/integration/profile.test.ts`, `sessions.test.ts` — FR-012, FR-014,
  FR-020, FR-USR-01, FR-ACC-04, FR-ACC-06.
- [X] T051 [US4] Profile service update; auth service change-password,
  list and revoke sessions; routes — `backend/src/profile/`, `backend/src/auth/` — T050
  green.
- [X] T052 [P] [US4] Frontend tests then Profile, ChangePasswordForm, SessionsList,
  revoke and log-out-everywhere dialogs, unsaved-changes guard; axe —
  `frontend/src/pages/profile/` — FR-034, FR-035.
- [X] T053 [US4] E2E: profile save, change password, revoke another session, which then
  sees "You've been logged out. Please log in again."; after a password change in
  another browser, "You were logged out because your password was changed." —
  `frontend/e2e/profile-sessions.spec.ts` — FR-036.
- [ ] T054 [US4] Checkpoint: `/code-review` + `/security-review`, fixes, CI green, stop.

---

## Phase 7: US5 — Forgot and reset a password (P2)

**Goal**: a user who forgot their password gets a link and sets a new one.
**Independent test**: quickstart step 7.

- [ ] T055 [P] [US5] Tests: forgot-password (`202` and email; `ACCOUNT_NOT_FOUND`,
  `ACCOUNT_DEACTIVATED`, nothing sent; new link supersedes, old → `TOKEN_SUPERSEDED`);
  resend/forgot rate limits per email with `Retry-After` (no per-IP limit); mail failure logged,
  request still succeeds — `backend/tests/integration/forgot-password.test.ts` — FR-015,
  FR-ACC-05, NFR-SEC-08.
- [ ] T056 [US5] Forgot-password service, route and template —
  `backend/src/accounts/`, `backend/src/mail/template.ts` — T055 green.
- [ ] T057 [P] [US5] Frontend tests then ForgotPassword page; ResetPassword links
  forgot-password on `TOKEN_EXPIRED`; E2E forgot → Mailpit → reset → login —
  `frontend/src/pages/account/`, `frontend/e2e/forgot-reset.spec.ts` — FR-034, FR-036.
- [ ] T058 [US5] Checkpoint: `/code-review` + `/security-review`, fixes, CI green, stop.

---

## Phase 8: US6 — Operator manages administrator accounts (P3)

**Goal**: the operator deactivates and reactivates admins from the command line.
**Independent test**: quickstart step 8.

- [ ] T059 [US6] Tests: `admin:deactivate` / `admin:reactivate` per
  [contracts/cli.md](contracts/cli.md) — exit codes `EXIT.OK/USAGE/REFUSED/UNAVAILABLE`,
  `LAST_ADMIN`, `NOT_AN_ADMIN`, sessions revoked with `DEACTIVATED`, `OPERATOR` audit,
  two concurrent deactivations of the last two admins under `ADMIN_LOCK` leave one —
  `backend/tests/integration/cli-admin-status.test.ts` — FR-027.
- [ ] T060 [US6] Both commands and their registration —
  `backend/src/cli/commands/admin-{deactivate,reactivate}.ts`,
  `backend/src/lib/operator-codes.ts` — T059 green.
- [ ] T061 [US6] Checkpoint: `/code-review`, fixes, CI green, stop.

---

## Phase 9: US7 — Retention, privacy and security records (P3)

**Goal**: ended sessions and old rate-limit windows are purged; no secret leaks. **Independent test**: quickstart step 9.

- [ ] T062 [P] [US7] Tests: purge deletes sessions ended > 90 days with their refresh
  tokens (newer kept); deletes ended rate-limit windows (current kept); runs only as
  `po_maintenance` — `backend/tests/integration/purge.test.ts` — FR-030, NFR-OPS-05.
- [ ] T063 [P] [US7] Tests: across the suite's captured logs, audit rows and responses,
  no token or password hash outside the allowed places; security events emitted for each
  FR-029 case — `backend/tests/integration/security-log.test.ts` — FR-029, SC-007,
  NFR-SEC-06.
- [ ] T064 [US7] Purge tasks and registry entries — `backend/src/maintenance/purge.ts`,
  `registry.ts` — T062, T063 green.
- [ ] T065 [US7] Checkpoint: `/code-review` + `/security-review`, fixes, CI green, stop.

---

## Phase 10: Polish

- [ ] T066 Authorization matrix generated from the route table: 22 operations × 6
  caller kinds (anonymous, no role, Buyer, Approver, Buyer+Approver, Admin), each cell
  asserted, public list pinned — `backend/tests/integration/authorization-matrix.test.ts`
  — FR-019, SC-005, NFR-AUTH-02.
- [ ] T067 [P] Bundle budget for every new route chunk (≤ 150 KB gzip) and axe across
  all new screens — `scripts/check-bundle-budget.mjs`, `frontend/e2e/` — SC-009.
- [ ] T068 Traceability: every row this slice touches names its passing tests and moves
  to `Done` — `docs/traceability.md`.
- [ ] T069 Run [quickstart.md](quickstart.md) on a clean `docker compose up` and record
  the results; `.env.example` and `README` notes — `specs/002-accounts-user-management/quickstart.md`.
- [ ] T070 Whole-PR `/code-review` and `/security-review`, `/speckit-analyze` re-run,
  CI green, PR #13 ready for owner review and merge.

---

## Out of scope (POC scope, owner decision 2026-11-03)

- Phone field, its purge and leak scans, `INVALID_PHONE`, `libphonenumber-js`.
- Cross-tab refresh coordination.
- The 10,000-user seed and committed query plans for the admin lists (slice 7 owns them).
- Per-IP limits on resend-verification and forgot-password.

## Dependencies and execution order

- Setup T001 first; T002, T003 [P] after it.
- Foundational: T004 → T005 → T006 → T007 → T008 → T009. T010 [P] any time; T011–T021 after T009, each
  test before its implementation (T012 → T013, T014 → T015, T016 → T017, T018 → T019);
  T020, T021 [P]. T022 closes the phase.
- Stories in order US1 → US7; each starts after the previous checkpoint is green.
  US2 needs US1's sessions; US3 needs US2's access requests; US4–US7 need US1.
- Within a story: [P] test tasks together, then implementation in listed order, then
  frontend, E2E, checkpoint.
- Polish after US7.

## Parallel examples

- Foundational: T010 any time; T011, T012, T020, T021 together once T009 is in.
- US1: T023–T026 together; T032 alongside T027–T031.
- US3: T043, T044 together; T047 alongside T045.

## Implementation strategy

- **MVP**: Setup + Foundational + US1 — real login for the bootstrap admin, which every
  later slice needs.
- Then US2 + US3 (self-service onboarding to a Buyer), US4 + US5 (self-service
  maintenance), US6 + US7 (operations), Polish.
