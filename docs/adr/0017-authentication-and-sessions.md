# ADR-0017: Authentication, accounts, sessions and CSRF

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (restricted signup, email
  verification, password policy and reset, lockout, session management, mail; signup
  with no role; 30-day absolute session lifetime; 90-day purge of session and
  security-log data)
- **Brief:** §6 ("every action tied to a real, authenticated user; no anonymous path")
- **Principles:** III, IX, XIII

## Context
Every action must be tied to an authenticated user. A browser SPA that keeps tokens in
JavaScript-readable storage can have them stolen through any XSS. Long-lived tokens also
delay deactivation and role changes.

There is no organisation boundary (one organisation per deployment, ADR-0019), and orders
up to ₹1,00,000 auto-approve (ADR-0002). **Open signup would let anyone outside the company
create an account and raise auto-approved orders.** Signup is therefore restricted to the
company's email domains, and an account works only after its mailbox is verified.

Even inside the company, the right to raise orders is granted, not self-served. A new
account therefore starts with **no role**. An administrator assigns one, usually in
answer to an in-app access request (ADR-0016).

## Decision

### Tokens and cookies
| Cookie | Content | Lifetime | Flags | Path |
|---|---|---|---|---|
| access | JWT `{ sub: userId, sid: sessionId }` | 15 min | HttpOnly, Secure, SameSite=Strict | `/api` |
| refresh | opaque random (256-bit) | 7 days idle, capped by the 30-day session limit | HttpOnly, Secure, SameSite=Strict | `/api/auth` |
| csrf | `HMAC(sessionId, server secret)` | same as the refresh cookie, re-issued on every refresh | Secure, SameSite=Strict (**not** HttpOnly, by design) | `/` |

- The refresh cookie is sent to `/api/auth/refresh`, `/api/auth/logout` and
  `/api/auth/logout-all` only. It never reaches the rest of `/api`.
- No auth token is ever readable by JavaScript or stored in `localStorage`. The CSRF token
  is not a credential. It is bound to the session, so a planted cookie can't forge it.
- The CSRF cookie lives exactly as long as the refresh cookie, and both are re-set on
  every refresh. A browser-session cookie would vanish on browser restart while the
  refresh cookie survived. The next refresh would then fail the CSRF check and log the
  user out for no reason.
- The JWT is signed with a key from the environment (HS256, ≥ 256-bit, `kid` header for
  rotation). It carries only the user id and the session id.
- **Every request loads `status` and `roles` from the database** (indexed by user id), so
  changes take effect immediately. A user who is no longer `ACTIVE` → `401`. A missing role
  → `403`.

### Signup and verification
- `POST /api/auth/signup { name, email, password }`, with a strict schema. A body with
  `roles`, `status` or any other field → `400`.
  - The email's domain must be in `SIGNUP_ALLOWED_DOMAINS` (validated config,
    comma-separated, case-insensitive, at least one entry). Otherwise →
    `400 SIGNUP_DOMAIN_NOT_ALLOWED`. This reveals nothing about which accounts exist.
  - The password must meet the policy below.
  - **Always `202`.**
    - A new email gets an `UNVERIFIED` user with role set `{}` (no role) and a
      verification email.
    - An already registered email gets the same `202` and a "you already have an account"
      email, with a link to reset the password.
  - **Self-signup never grants any role.** BUYER and APPROVER come from an Admin
    (ADR-0016). ADMIN comes from the bootstrap script or the operator CLI.
- After verification and login, a no-role user sees the "Access pending" screen
  (ADR-0018). Every endpoint except `/me`, password, sessions, logout and their access
  request → `403 NO_ROLE_ASSIGNED`.
- `POST /api/auth/verify-email { token }` → the user becomes `ACTIVE`. It doesn't log the
  user in.
- `POST /api/auth/resend-verification { email }` → always `202`. An email is sent only when
  an `UNVERIFIED` user has that address.
- **Squatting**: someone may sign up first with a colleague's address. That account stays
  `UNVERIFIED` and can't log in. When the real owner signs up, they get the "already have
  an account" email, and completing the reset sets their own password and verifies the
  account.

### Passwords
- **Policy**: 12–128 characters, and not on a bundled common-password list (checked
  offline, no network call). Field codes: `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`,
  `PASSWORD_TOO_COMMON`.
- Hashed with argon2id. Admins never set or see passwords.
- `POST /api/auth/change-password { currentPassword, newPassword }`:
  - A wrong current password → `400 VALIDATION_FAILED` with field code
    `INCORRECT_PASSWORD`. It is rate-limited like login and counts toward the lockout.
  - On success, every **other** session of the user is revoked and the current one is kept.
- `POST /api/auth/forgot-password { email }`: always `202`. A reset email is sent only to
  an `UNVERIFIED` or `ACTIVE` user with that address.
- `POST /api/auth/reset-password { token, newPassword }`:
  - sets the password
  - revokes **all** of the user's sessions
  - clears any lockout
  - turns an `UNVERIFIED` user `ACTIVE`, since the reset proves control of the mailbox
  - The user then logs in.

### One-time tokens
- 256-bit random, stored only as a SHA-256 hash, single use, with a purpose:
  - `VERIFY_EMAIL`: valid 24 h
  - `RESET`: valid 30 min
- Issuing a new token invalidates the user's earlier unused tokens with the same purpose.
- An invalid, expired, used or superseded token → `400 INVALID_TOKEN`. All four look the
  same.
- Links point at the frontend (`APP_ORIGIN/verify-email?token=…`,
  `/reset-password?token=…`). The token is in the URL only. It is never logged, and the
  page posts it once.

### Anti-enumeration and timing
- Login, signup, resend-verification and forgot-password give the same response whether or
  not the account exists. An unknown email at login runs a dummy argon2id hash. So does an
  account with no password hash yet: an admin created by bootstrap or `admin:create` before
  the set-password link is used.
- Signup, resend and forgot-password **equalise response time**: mail is dispatched after
  the response, and each handler pads to a fixed minimum duration (for example 400 ms
  [TARGET]), so the work done for an existing account doesn't show in timing.

### Login, lockout and rate limits
- `401 INVALID_CREDENTIALS` is the single response for an unknown email, a wrong password,
  an `UNVERIFIED` or `DEACTIVATED` account, and a locked account.
- **Per-account lockout**: 5 consecutive failed logins → locked for 15 minutes.
  - The counter and `lockedUntil` live on the user row (PostgreSQL), so they hold across
    instances.
  - A successful login resets the counter. A completed reset clears the lock.
  - Accepted trade-off: anyone who knows an email can lock that account for 15 minutes.
    Per-IP rate limits slow this down, and the owner can always use forgot-password.
- **Rate limits** [TARGET]:
  - login: ≤ 10 per minute per IP and per account
  - signup: ≤ 5 per hour per IP and ≤ 3 per hour per email
  - resend-verification and forgot-password: ≤ 10 per hour per IP and ≤ 3 per hour per
    email
  - Over the limit → `429 RATE_LIMITED` with `Retry-After`. A per-email limit on a `202`
    endpoint still returns `202` and silently sends nothing, so it can't be used to
    discover accounts.

### Sessions and refresh rotation
- Table `sessions` (one row per refresh family): id, user, created at, last used at (set
  on login and each refresh), **absolute expiry** (`created_at` + 30 days), user agent, IP,
  revoked at, revoke reason.
- **Two lifetimes**:
  - **Idle**: each refresh token is valid for 7 days, so a session unused for 7 days ends.
  - **Absolute**: a session ends 30 days after login, however active it is [TARGET].
    Rotation **never** extends it. A new refresh token's expiry is the earlier of
    now + 7 days and the session's absolute expiry. The refresh cookie's `Max-Age`
    matches.
  - Past either limit → `401 SESSION_EXPIRED`, and the user logs in again.
- Table `refresh_tokens`: session, token hash (SHA-256), expiry, rotated at.
- `POST /api/auth/refresh` rotates the token: it marks the old row rotated (`rotated_at`),
  issues a new token in the same session, and sets new access and refresh cookies.
- **Reuse detection**: presenting a token that was already rotated, outside the grace
  window, revokes the whole session → `401 SESSION_REVOKED`, and the user must log in
  again.
- **10-second grace window (sibling tokens)**: if a just-rotated token is presented within
  10 s of its `rotated_at`, it issues **another new token in the same session** (a sibling)
  instead of being treated as reuse. Concurrent refreshes from several tabs therefore all
  succeed, and the session stays valid.
  - Each sibling is an ordinary single-use token, subject to the same rules.
  - Nothing but hashes is ever stored.
  - Accepted trade-off: a stolen token used within 10 s of a legitimate rotation also gets a
    sibling instead of triggering revocation. The window is short, the token is HttpOnly
    and limited to `/api/auth`, and reuse after the window still revokes the whole session.
- An expired refresh token or a session past its absolute expiry → `401 SESSION_EXPIRED`.
  A refresh on a revoked session → `401 SESSION_REVOKED`.
- **Session management**:
  - `GET /api/auth/sessions` lists the caller's active sessions: id, createdAt,
    lastUsedAt, user agent, IP, and `current: true` on the calling session. It is
    paginated per ADR-0007, sorted by `lastUsedAt` descending, then `id`.
  - `DELETE /api/auth/sessions/:id` revokes one session.
    - Another user's session id → `404`.
    - Revoking the current session also clears its cookies, like logout.
- Revocation is checked at refresh. An access token already issued to a revoked session
  stays valid until it expires (≤ 15 min).
  - Accepted trade-off: this keeps the per-request lookup to the user row.
  - Deactivation and role changes still take effect on the very next request, through the
    per-request load of status and roles.

### Logout and revocation
- `POST /api/auth/logout` revokes the session identified by **the refresh token itself**,
  so it works even when the access token has expired. It clears all cookies with matching
  `Path`s.
- `POST /api/auth/logout-all` revokes every session of the user identified by the refresh
  token.
- These revoke all of the user's sessions:
  - deactivation and role changes (ADR-0016)
  - a completed password reset
- A password change revokes every other session.

### CSRF
Three layers on every state-changing request:
- `SameSite=Strict`
- an `Origin` check (must equal the configured app origin)
- the `X-CSRF-Token` header must match the session-bound HMAC

Failure → `403 CSRF_REJECTED`. The public endpoints have no session yet (login, signup,
verify-email, resend-verification, forgot-password, reset-password). They rely on the
`Origin` check and `SameSite`.

### Mail
- A `Mailer` interface (`send(template, to, variables)`) with an SMTP adapter. The SMTP
  host, port, credentials, TLS mode and sender address are validated at startup, and
  invalid config means the process exits.
- Templates (text and HTML):
  - verify email
  - already have an account
  - reset password
  - admin-initiated reset (same link, different wording)
- **Emails are sent after the transaction commits, never inside it**. A rolled-back
  command sends nothing.
  - There's no outbox (ADR-0019). If sending fails, the failure is logged and the user
    retries with resend-verification or forgot-password.
- **Mailpit** runs in docker compose under the `local` profile (SMTP on the internal
  network, web UI on `localhost:8025`). `.env.example` sets `COMPOSE_PROFILES=local`, so
  `docker compose up` still needs only `.env`.
  - A deployment's `.env` leaves the profile unset and points the SMTP settings at a real
    relay.
  - With `APP_ENV=production`, config validation refuses an SMTP host of `mailpit`, so real
    users' emails can never be swallowed by the test inbox.
- Tests use an in-memory capture adapter. Playwright reads mail through Mailpit's API.

### Deployment
- Same origin: nginx in docker compose serves the frontend and proxies `/api` to the API.
  No CORS is needed, and cross-origin requests are rejected.
- `Secure` cookies work on `http://localhost` (browsers treat it as a secure context). Any
  other deployment terminates TLS at nginx.
- **Rate-limit counters**: an in-memory store is acceptable **only** for the single API
  instance in docker compose. Any multi-instance deployment MUST use a shared store (a
  PostgreSQL table or Redis), so limits hold across instances. The store is chosen by
  configuration and validated at startup. If more than one instance is configured with the
  in-memory store, startup fails. Lockout state is always in PostgreSQL.

### Security logs
These events are written as structured `security` log entries, separate from the business
audit:
- signup
- email verification
- login success and failure (including the reason internally: unknown email, wrong
  password, unverified, deactivated, locked)
- lockout
- logout and logout-all
- refresh-reuse detection
- session revoked (with who revoked it and why)
- reset requested and completed
- password changed
- mail send failure

Each entry has the user id when known, IP, user agent, session id and request id. Entries
never contain tokens, passwords or phone numbers. The only exceptions are the set-password
links printed by bootstrap and by `admin:create` (ADR-0016).

### Retention of session and security data (DPDP Act 2023)
- IP addresses and user agents are personal data, kept only as long as they serve
  security.
- Session rows and their refresh tokens are purged **90 days after the session ends**
  (revoked, or past its idle or absolute expiry) [TARGET].
- Security log entries are purged after 90 days in the log store.
- The purge runs daily under the maintenance database role (ADR-0020).
- Business audit has its own 8-year rule (ADR-0016).

## Alternatives
- **Open signup**: outsiders could raise auto-approved orders. Rejected.
- **Self-signup grants BUYER** (the earlier draft): any verified employee could raise
  orders that auto-approve up to ₹1,00,000. Replaced by the no-role account.
- **Admin-approved signup** (accounts can't log in until an admin activates them): the
  user can't even see why they're waiting or ask for access. The no-role account gives
  the same control, plus a working profile and an in-app access request.
- **No self-signup** (admin invites only): every account starts with an admin. Not adopted.
  Self-signup with no role costs the admin one role assignment and no account
  administration.
- Bearer tokens in `localStorage`: readable by any XSS. Rejected.
- Server-side sessions only (no JWT): simpler revocation, but a session lookup on every
  request. We already load the user on every request, and the JWT saves the session
  lookup. Revocation applies at refresh, within 15 minutes.
- Checking the session on every request: makes revocation immediate, at the cost of a
  second lookup. Not adopted, because deactivation and role changes are already immediate.
- Long-lived access tokens: delay deactivation. Rejected.

## Tests
- Signup and verification:
  - a disallowed domain → 400 `SIGNUP_DOMAIN_NOT_ALLOWED`; domain matching is
    case-insensitive
  - a duplicate signup gives the same 202 (body, headers, timing within tolerance) and sends
    the "already have an account" email
  - an unverified user can't log in (401 `INVALID_CREDENTIALS`)
  - verify → `ACTIVE`
  - resend-verification returns 202 for unknown and active emails, and sends nothing
  - self-signup always gets `{}`; `roles` in the body → 400
  - a verified no-role user can log in and gets `403 NO_ROLE_ASSIGNED` everywhere except
    `/me`, password, sessions, logout and the access request
- Tokens: an expired, used or superseded token → `INVALID_TOKEN`; a new token invalidates
  the previous one with the same purpose; the database stores only the hash.
- Passwords:
  - policy field codes
  - change-password revokes the other sessions and keeps the current one
  - a wrong current password → 400 `INCORRECT_PASSWORD`
  - forgot-password returns 202 for an unknown email
  - reset-password revokes all sessions, clears a lockout and activates an `UNVERIFIED`
    user
- Lockout:
  - 5 failures → the sixth attempt with the right password gets the same 401
  - unlocked after 15 minutes (with an injected clock)
  - the counter resets on success
  - lockout holds across two app instances
- Rate limits: signup, resend and forgot-password limits; a per-email limit on a 202
  endpoint still returns 202.
- Sessions:
  - the list shows only the caller's sessions and marks the current one
  - revoking a session → that session's next refresh → 401 `SESSION_REVOKED`
  - another user's session id → 404
  - revoking the current session clears its cookies
- Mail: sent only after commit, with nothing sent on rollback; a mail failure is logged and
  the request still succeeds; invalid SMTP config fails startup.
- Session lifetimes (injected clock):
  - a session refreshed every day still ends at 30 days → 401 `SESSION_EXPIRED`
  - the refresh token's expiry never exceeds the absolute expiry
  - a session idle for 7 days → 401 `SESSION_EXPIRED`
- Purge: sessions ended more than 90 days ago are deleted with their refresh tokens; newer
  ones stay; the purge runs only as the maintenance role.
- Rotation:
  - rotation issues a new pair
  - reuse of a rotated token after 10 s → session revoked → 401 `SESSION_REVOKED`
  - concurrent refreshes within 10 s both succeed (sibling tokens) and the session stays
    valid
- Logout:
  - logout with an expired access token still revokes the session
  - logout-all revokes every session
- Cookies:
  - the refresh cookie is not sent to non-auth `/api` routes (Path asserted)
  - flags asserted (HttpOnly, Secure, SameSite=Strict, Path), and no token in any response
    body
- The rate limiter uses the configured store (a shared-store test with two app instances).
- A deactivated user's next request → 401. A removed role → next request 403.
- CSRF:
  - a missing or wrong CSRF token → 403 `CSRF_REJECTED`
  - a cross-origin `Origin` → 403, on public endpoints as well
  - after a simulated browser restart (session cookies dropped), refresh succeeds and the
    next state-changing request passes the CSRF check
- Login: the login rate limit → 429; an unknown email and a wrong password give identical
  responses. An account with no password hash (bootstrap or CLI-created, link not yet
  used) runs the dummy hash and returns the same 401 `INVALID_CREDENTIALS`, with timing
  within tolerance of a wrong password.
- Security log events are emitted for each event listed, without secrets.
