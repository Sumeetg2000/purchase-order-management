# Research: Slice 1 — Accounts and user management

Every number and mechanism below comes from ADR-0004, 0006, 0007, 0016, 0017 (amended
2026-11-02), 0018 and 0020. This file records only the choices the ADRs leave to the plan.
No `NEEDS CLARIFICATION` remains: the one spec question (FR-016) was answered on
2026-11-02, counters live in PostgreSQL.

## R1. Access levels and the authenticate step

- **Decision**: `ACCESS_LEVELS` grows from `['public']` to
  `['public', 'refresh', 'user', 'no-role', 'admin']`, a string-literal union in
  `@po/contracts` (later slices add `buyer`, `approver` and so on).
  - `public`: no session. Origin check and `SameSite` only.
  - `refresh`: authenticated by the refresh cookie, not the access token (refresh, logout,
    logout-all). CSRF header required.
  - `user`: any logged-in user, with or without a role (`/me`, change-password, sessions).
  - `no-role`: logged in with role set `{}` only (own access request). A user with a role →
    `403 FORBIDDEN`.
  - `admin`: `{ADMIN}` only. No role → `403 NO_ROLE_ASSIGNED`; another role →
    `403 FORBIDDEN`.
- `createApp` inserts one `authenticate(route.access)` step **before** the body is parsed
  or validated, so the order is ADR-0004's (amended 2026-11-03): `401` → CSRF →
  `403 NO_ROLE_ASSIGNED` → `403 FORBIDDEN` (the route's access level) → `400` → `404` →
  order-level `403` → `409`.
  The step verifies the access cookie, loads `status` and `roles` by primary key (one
  indexed read per request), refuses non-`ACTIVE` users with `401 ACCOUNT_DEACTIVATED`,
  checks CSRF on state-changing methods, and puts a typed `req.auth` (user id, session id,
  roles, name, email) on the request.
- The step lives in `http/middleware/authorize.ts` and calls `auth/service.ts`; it never
  touches a repository, matching the route rule in CLAUDE.md.
- **Rationale**: one place enforces deny-by-default; the existing startup check already
  rejects an unknown level, and the route-table test generates the matrix from it.
- **Alternatives**: per-route guard functions (easy to forget, not visible to the
  generator); role arrays on each operation (no way to express "no role only").

## R2. Cookies and the access token

- **Decision**:
  - Cookie names are constants: `po_access` (Path `/api`), `po_refresh` (Path `/api/auth`),
    `po_csrf` (Path `/`). No `__Host-`/`__Secure-` prefix: `__Host-` forbids a non-root
    path, and Firefox refuses prefixed cookies on `http://localhost`.
  - Set with Express's `res.cookie` (HttpOnly, Secure, SameSite=Strict, `Max-Age` per
    ADR-0017). Read with `cookie` 2.0.1's `parse`, declared as a direct dependency.
  - Access JWT with `jose` 6.2.12: HS256, `kid` header, claims `sub`, `sid`, `iat`, `exp`
    only. Signing key `JWT_SIGNING_KEY` (≥ 32 bytes, base64url), `JWT_KEY_ID`.
  - `jose`'s `JWTExpired` (signature valid, `exp` passed) → `401 ACCESS_TOKEN_EXPIRED`.
    Every other failure, an unknown `kid` included → `401 UNAUTHENTICATED`.
- **Rationale**: `jose` is dependency-free and maintained; it reports expiry separately
  from signature failure, which the two codes need. Rotation is by changing the key: the
  old tokens then fail as `UNAUTHENTICATED` and users log in again. No key ring is built
  (no infrastructure the brief doesn't ask for).
- **Alternatives**: `jsonwebtoken` (CommonJS, extra deps); a hand-written HMAC JWT (no).

## R3. Password hashing

- **Decision**: `argon2` 0.45.1 (prebuilt binaries for glibc and musl, no build step),
  argon2id with OWASP's minimum profile as named constants: memory 19 MiB, 2 iterations,
  parallelism 1. `needsRehash` on login upgrades old hashes silently.
- **Rationale**: ADR-0017 fixes argon2id; this profile keeps a login near 50 ms on the CI
  runner, so the login p95 and the test suite stay fast.
- **Alternatives**: `@node-rs/argon2` (fine, but less used and released less often).

## R4. Password policy and its field codes

- **Decision**:
  - `passwordSchema` in `@po/contracts`: `z.string()` with a `superRefine` that adds a
    custom issue carrying `params.fieldCode` (`PASSWORD_TOO_SHORT` below 12,
    `PASSWORD_TOO_LONG` above 128). `.meta()` overrides document `minLength: 12` and
    `maxLength: 128` in the OpenAPI.
  - `fieldCode()` in `define-route.ts` maps a custom issue to its `params.fieldCode` when
    that is a registered `FieldCode`, else `INVALID_FORMAT`. No message text is read.
  - `PASSWORD_TOO_COMMON` is a service check, not a schema one: the list stays out of the
    web bundle. Same `400 VALIDATION_FAILED` shape, path `body.password` (or
    `body.newPassword`).
  - The list: `backend/src/auth/common-passwords.txt`, the NCSC 100k list from SecLists
    (MIT), kept to the entries of 12–128 characters, compared lower-cased, loaded once
    into a `Set`. A header names the source; a test pins its line count and SHA-256.
- **Rationale**: the shared schema gives the web form the same length rules; one mapping
  point keeps codes out of messages.
- **Alternatives**: zxcvbn (large, scores instead of a list, not what ADR-0017 says).

## R5. Refresh rotation and the sibling window

- **Decision**: `POST /api/auth/refresh` runs in one transaction:
  1. `SELECT … FROM refresh_tokens JOIN sessions … WHERE token_hash = $1 FOR UPDATE` (the
     token row, then the session row).
  2. Unknown hash → `401 SESSION_EXPIRED` (indistinguishable from a purged one). User not
     `ACTIVE` → `401 ACCOUNT_DEACTIVATED`. Session revoked → `401 SESSION_REVOKED` with
     `reason` = its `revoke_reason` when that is public, otherwise no `reason`. Token or session past expiry → `401 SESSION_EXPIRED`.
  3. `rotated_at` null → set it, insert the next token. `rotated_at` within
     `REFRESH_SIBLING_GRACE_SECONDS` (10) → insert a sibling. Later → revoke the session
     (`REUSE_DETECTED`), security log, `401 SESSION_REVOKED` without a `reason`.
  4. New token expiry = min(now + 7 days, session absolute expiry); `sessions.expires_at`
     = greatest of its current value and that; `last_used_at` = now.
- The row lock serialises concurrent refreshes of one token, so two tabs can't both see
  `rotated_at` null.
- **Alternatives**: a family-wide counter (loses the sibling rule); Redis (excluded).

## R6. When a session has ended

- **Decision**: `sessions.expires_at` holds the latest refresh token's expiry (never past
  `absolute_expires_at`). A session has ended when `revoked_at` is set or `expires_at` has
  passed. The purge deletes sessions where `coalesce(revoked_at, expires_at)` is older
  than 90 days, through an expression index; refresh tokens go with them
  (`ON DELETE CASCADE`).
- The sessions list shows sessions not ended, sorted `last_used_at DESC, id DESC`, index
  `(user_id, last_used_at DESC, id DESC)`.
- **Rationale**: one column answers "ended?" for the list, the refresh and the purge.

## R7. CSRF

- **Decision**: `po_csrf` = base64url(HMAC-SHA256(`CSRF_SECRET`, session id)). The
  authorize step recomputes it from the session id in the access token (or, for
  `refresh`-level routes, from the refresh token's session) and compares the
  `X-CSRF-Token` header in constant time. `GET`/`HEAD` are exempt. The existing origin
  guard stays first.
- Cookie lifetime equals the refresh cookie's and it is re-set on every refresh
  (ADR-0017).

## R8. Rate limits in PostgreSQL

- **Decision**: table `rate_limit_counters (bucket, key, window_start, hits)` with a fixed
  window per bucket.
  - One statement per check: `INSERT … ON CONFLICT (bucket, key, window_start) DO UPDATE
    SET hits = rate_limit_counters.hits + 1 RETURNING hits`. Over the limit →
    `429 RATE_LIMITED` with `Retry-After` = seconds to the end of the window, rounded up.
  - It runs in its own autocommit statement **before** the command's transaction, so a
    refused or failed command still counts.
  - Buckets are a const list with their limit and window, defined once in
    `rate-limit/buckets.ts`: `login-ip` 30/min, `login-account` 10/min, `signup-ip` 5/h,
    `signup-email` 3/h, `resend-email` 3/h, `forgot-email` 3/h, `access-request-user` 3/day. Change-password uses `login-account`.
  - Keys: the client IP (`req.ip`, trust proxy 1) or the lower-cased email or user id.
  - Order: after the body schema (the email comes from the body), before any lookup.
  - The daily purge deletes windows that ended more than a day ago, so IPs aren't kept.
- **Rationale**: ADR-0017 as amended. Fixed windows need one row and one statement; a
  burst of twice the limit across a boundary is acceptable for these numbers.
- **Alternatives**: sliding log (a row per attempt); `express-rate-limit` with a
  PostgreSQL store (an extra dependency for one upsert).

## R9. Lockout

- **Decision**: a wrong password runs one atomic `UPDATE users SET failed_login_count =
  failed_login_count + 1, locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN $now
  + 15 min END … RETURNING`. Reaching 5 resets the count to 0 and sets `locked_until`. A
  success sets the count to 0 and `last_login_at`. A completed reset clears both. None of
  these bump `version`.
- Times come from the injected clock, passed as parameters, so tests move time without
  sleeping.

## R10. Clock

- **Decision**: a `Clock` (`now(): Date`) in `lib/clock.ts`, injected into services; the
  system clock in production, a settable one in tests. Audit `occurred_at` keeps the
  database clock (slice 0).

## R11. Phone numbers

- **Withdrawn 2026-11-03** (POC scope, owner decision): no phone field, so no
  normalisation library and no `INVALID_PHONE` (ADR-0016).

## R12. Acting role for self-service events

- **Decision**: `actingRole` is `SELF` for events a user performs on their own account
  (signup, verification, profile, access request), `ADMIN` for user management. A const
  list `ACTING_ROLES = [...USER_ROLES, 'SELF']` types it.
- **Rationale**: the audit `CHECK` requires an acting role for `USER` entries, and a
  no-role user has no role to act in.

## R13. Admin user list and its query plans

- **Decision**:
  - Filters in SQL: `status`, `role` (`NONE` → `roles = '{}'`, otherwise
    `$role = ANY(roles)`), `q` → `lower(name) LIKE $p OR lower(email) LIKE $p` with
    `$p` = the escaped prefix + `%`.
  - Indexes from ADR-0016: `(name, id)`, `(status, name, id)`,
    `lower(name) text_pattern_ops`, `lower(email) text_pattern_ops`. Access requests:
    `(status, updated_at DESC, id DESC)` and `(updated_at DESC, id DESC)`.
  - Raw SQL through `$queryRaw` in the repository (Prisma can't express the prefix
    predicate on an expression index); one page query and one `COUNT`.
  - No 10,000-user seed or committed plans in this slice (2026-11-03, POC scope, owner
    decision): slice 7 builds the query-plan tooling with the other load work and
    commits the plans for these two lists. The indexes ship now.

## R14. Versioned admin updates

- **Decision**: an operation flag `ifMatch: 'required'` in the contract. The generator
  documents a required `If-Match` header, and `validateRequest` parses it before the body:
  missing → `400 VALIDATION_FAILED` with field code `VERSION_REQUIRED` at
  `header.if-match`; not `"<integer>"` → `INVALID_FORMAT`. A stale version →
  `409 VERSION_CONFLICT` from the repository's `UPDATE … WHERE id = $1 AND version = $2`.
  `GET` and `PATCH` return `ETag: "<version>"` (ADR-0006).
- ADR-0016 writes "`400 VERSION_REQUIRED`"; ADR-0007 lists it as a field code of
  `VALIDATION_FAILED`. The registry follows ADR-0007, and the spec's wording means the same
  response.

## R15. Responses without a body

- **Decision**: a shared `noContent` marker in the contract. `204` for verify-email,
  reset-password, change-password, refresh, logout, logout-all and session revoke; `202`
  for signup, resend-verification, forgot-password and admin reset (mail is queued after
  commit). Login answers `200` with the `Me` body, so the web app needs no second call.

## R16. Mail

- **Decision**: three templates join the slice 0 registry: `verify-email`,
  `reset-password`, `admin-reset-password`. Links use the fragment form
  (`APP_ORIGIN/verify-email#token=…`). Sending stays after commit; a failure is logged as
  `mail_send_failed` and the request still succeeds.

## R17. Web app auth flow

- **Decision**:
  - `openapi-fetch` middleware adds `X-CSRF-Token` (read from `po_csrf`) on mutating calls.
  - On `401 ACCESS_TOKEN_EXPIRED` it calls one shared `refreshSession()`, single-flight
    within the tab. Tabs are not coordinated (ADR-0018, amended 2026-11-03): each
    refreshes on its own and the server's 10-second sibling window lets them all
    succeed. Each queued request retries once.
  - `SESSION_EXPIRED` → the session-expired message, `SESSION_REVOKED` → "You were logged
    out because <reason>." or, without a `reason`, "You've been logged out." (errors.md), both then `/login?returnTo=…`; `ACCOUNT_DEACTIVATED` → login with its message;
    `NO_ROLE_ASSIGNED` → Access pending; `UNAUTHENTICATED` → login, no refresh.
  - The current user comes from `GET /api/me` (TanStack Query); route guards read it.
  - Account pages read `location.hash`, `history.replaceState` it away, and post the token
    once (a ref guards React's double effect in development).
- **Rationale**: ADR-0018. Cross-tab coordination (Web Locks, BroadcastChannel) was
  dropped as POC scope: the sibling window already makes concurrent refreshes safe.

## R18. Security log

- **Decision**: `SECURITY_EVENTS` gains `signup`, `email_verified`, `login_succeeded`,
  `login_failed` (with `reason`: `unknown_email`, `locked`, `password_not_set`,
  `wrong_password`, `unverified`, `deactivated`), `account_locked`, `logout`,
  `logout_all`, `refresh_reuse_detected`, `session_revoked` (`by`, `reason`),
  `password_reset_requested`, `password_reset_completed`, `password_changed`. Fields:
  `userId`, `ip`, `userAgent`, `sessionId`; the request id comes from the request logger.
  The logger's redaction paths already cover cookies, `password` and tokens; a
  test drives every event and scans the captured lines.

## R19. Purge

- **Decision**: two tasks join `maintenance/registry.ts`: `sessions` (ended > 90 days)
  and `rate_limit_counters` (windows ended > 1 day). Grants: `po_maintenance` gets
  `DELETE` on `sessions`, `refresh_tokens` and `rate_limit_counters`, nothing more. No
  phone purge (no phone field, 2026-11-03).

## R20. Demo seed

- **Decision**: migrate step 5 (`SEED_DEMO_DATA=true`, refused in production since
  slice 0) inserts two Buyers and one Approver, exactly ADR-0020's "Buyers and one
  Approver", all `ACTIVE`, with the local-only password `DEMO_PASSWORD` documented in the
  quickstart. No admin. Idempotent: an existing email is left alone.
- **Alternatives**: a dual-role demo user (not in ADR-0020; tests build their own).

## R21. New dependencies

| Package | Version | Where | Why |
|---|---|---|---|
| `argon2` | 0.45.1 | backend | argon2id (R3) |
| `jose` | 6.2.12 | backend | access JWT (R2) |
| `cookie` | 2.0.1 | backend | cookie parsing (R2) |

Each is the newest release at least two weeks old on 2026-11-02, pinned exactly. No new
service and no frontend dependency.
