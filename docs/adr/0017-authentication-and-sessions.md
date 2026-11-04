# ADR-0017: Authentication, accounts, sessions and CSRF

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (restricted signup, email
  verification, password policy and reset, lockout, session management, mail; signup
  with no role; 30-day absolute session lifetime; 90-day purge of session and
  security-log data) · amended 2026-10-27 (one-time tokens travel in the URL fragment,
  never the query; the edge masks token queries in its access log; production SMTP
  requires TLS) · amended 2026-11-02 (POC: clear, specific error messages over
  anti-enumeration, **owner decision**: one code per login failure, `EMAIL_IN_USE` and
  `ACCOUNT_NOT_FOUND` instead of silent `202`s, no dummy hash or timing padding,
  `ACCESS_TOKEN_EXPIRED` separate from `UNAUTHENTICATED`; rate-limit counters always in
  PostgreSQL, **owner decision**) · amended 2026-11-03 (one code per failed one-time
  token; `SESSION_REVOKED` carries the revoke reason, **owner decision**) · amended
  2026-11-03 (POC scope, owner decision: resend-verification and forgot-password are
  limited per email only; no phone in security logs because none is stored;
  `SESSION_REVOKED` names only the three public revoke reasons) · amended 2026-11-03
  (**owner decision**: revocation takes effect on the next request, since every request
  reads its session with its user; the access cookie lives as long as the refresh cookie,
  and the JWT inside it still expires after 15 minutes) · amended 2026-11-04 (**owner
  decision**: a new password equal to the current one → `PASSWORD_UNCHANGED`)
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
| access | JWT `{ sub: userId, sid: sessionId }` | the cookie as long as the refresh cookie; the JWT's `exp` 15 min | HttpOnly, Secure, SameSite=Strict | `/api` |
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
- An access token that is well formed and correctly signed but past its expiry →
  `401 ACCESS_TOKEN_EXPIRED`. No access token, or a malformed or wrongly signed one →
  `401 UNAUTHENTICATED`. The web app refreshes only on `ACCESS_TOKEN_EXPIRED` (ADR-0018).
- The access cookie outlives its JWT on purpose (amended 2026-11-03): a cookie that
  expired with the JWT would vanish from the browser, the next request would arrive with
  no token and get `UNAUTHENTICATED`, and the silent refresh on `ACCESS_TOKEN_EXPIRED`
  would never run.
- **Every request loads its session with its user from the database** (amended
  2026-11-03, owner decision): one indexed lookup of the session by id, joined to its user,
  so revocation, deactivation and role changes all take effect on the very next request.
  In the refresh's order:
  - a user who is not `ACTIVE` → `401 ACCOUNT_DEACTIVATED`
  - a revoked session → `401 SESSION_REVOKED`, with the reason only when it is public
  - a session past its idle or absolute end → `401 SESSION_EXPIRED`
  - a session that no longer exists, or isn't the token's user's → `401 UNAUTHENTICATED`
  - a missing role → `403`
- The web app ends the session on `SESSION_REVOKED` or `SESSION_EXPIRED` from any call, as
  it does on `ACCOUNT_DEACTIVATED`, and shows its message (ADR-0018).

### Signup and verification
- `POST /api/auth/signup { name, email, password }`, with a strict schema. A body with
  `roles`, `status` or any other field → `400`.
  - The email's domain must be in `SIGNUP_ALLOWED_DOMAINS` (validated config,
    comma-separated, case-insensitive, at least one entry). Otherwise →
    `400 SIGNUP_DOMAIN_NOT_ALLOWED`.
  - The password must meet the policy below.
  - A new email → `202`: an `UNVERIFIED` user with role set `{}` (no role) and a
    verification email.
  - An email that already has an account, in any status → `409 EMAIL_IN_USE`, and nothing
    is created or sent. The message points to login and forgot-password.
  - **Self-signup never grants any role.** BUYER and APPROVER come from an Admin
    (ADR-0016). ADMIN comes from the bootstrap script or the operator CLI.
- After verification and login, a no-role user sees the "Access pending" screen
  (ADR-0018). Every endpoint except `/me`, password, sessions, logout and their access
  request → `403 NO_ROLE_ASSIGNED`.
- `POST /api/auth/verify-email { token }` → the user becomes `ACTIVE`. It doesn't log the
  user in.
- `POST /api/auth/resend-verification { email }`:
  - an `UNVERIFIED` user → `202`, and a new verification email is sent
  - no account → `404 ACCOUNT_NOT_FOUND`
  - an `ACTIVE` account → `409 ACCOUNT_ALREADY_VERIFIED`
  - a `DEACTIVATED` account → `401 ACCOUNT_DEACTIVATED`
- **Squatting**: someone may sign up first with a colleague's address. That account stays
  `UNVERIFIED` and can't log in. When the real owner signs up, they get
  `409 EMAIL_IN_USE`, whose message points to forgot-password. Completing the reset sets
  their own password and verifies the account.

### Passwords
- **Policy**: 12–128 characters, and not on a bundled common-password list (checked
  offline, no network call). Field codes: `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`,
  `PASSWORD_TOO_COMMON`.
- Hashed with argon2id. Admins never set or see passwords.
- `POST /api/auth/change-password { currentPassword, newPassword }`:
  - A wrong current password → `400 VALIDATION_FAILED` with field code
    `INCORRECT_PASSWORD`. It is rate-limited like login and counts toward the lockout.
  - Once the current password is verified, a new password equal to it → `400
    VALIDATION_FAILED` with field code `PASSWORD_UNCHANGED` on `newPassword`, found by
    comparing the two inputs (no extra hash). Nothing is written and no session is revoked.
  - On success, every **other** session of the user is revoked and the current one is kept.
- `POST /api/auth/forgot-password { email }`:
  - an `UNVERIFIED` or `ACTIVE` user → `202`, and a reset email is sent
  - no account → `404 ACCOUNT_NOT_FOUND`
  - a `DEACTIVATED` account → `401 ACCOUNT_DEACTIVATED`
- `POST /api/auth/reset-password { token, newPassword }`:
  - a link for an account `DEACTIVATED` since it was sent → `401 ACCOUNT_DEACTIVATED`,
    rolled back so the link stays unused, as verify-email does (amended 2026-11-04, owner
    decision: a deactivated account can't reset its password)
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
- A failed token gets its own code (amended 2026-11-03), checked in this order:
  - used → `400 TOKEN_USED` ("This link has already been used.")
  - superseded → `400 TOKEN_SUPERSEDED` ("A newer link was sent. Use the latest email.")
  - expired → `400 TOKEN_EXPIRED` ("This link has expired. Request a new one.")
  - unknown (no row with that hash and purpose, including one already purged) →
    `400 INVALID_TOKEN`
- Links point at the frontend with the token in the **fragment**:
  `APP_ORIGIN/verify-email#token=…` and `APP_ORIGIN/reset-password#token=…`. This covers
  every link: the bootstrap and `admin:create` set-password links, and from slice 1 the
  verification, forgot-password and admin-triggered reset emails.
  - Browsers never send a fragment, so the token can't reach the edge's access log, any
    proxy, or a `Referer` header.
  - The page reads `location.hash`, removes it from the address bar
    (`history.replaceState`), and POSTs the token once in the request body. The API never
    accepts a token in a query string.
  - Backstop: the edge's access log masks any query whose key ends in `token` as
    `?[redacted]`, in the request line and in the `Referer`, so a legacy `?token=` link
    never logs the value (`deploy/nginx/default.conf`; checked by `scripts/smoke.sh`).

### Specific failures over anti-enumeration (amended 2026-11-02)
- POC: clear, specific error messages over anti-enumeration (owner decision). Login,
  signup, resend-verification and forgot-password each say exactly what went wrong,
  including whether the email has an account.
- There is no dummy hash and no response-time padding. Mail is still dispatched after the
  transaction commits.
- Accepted consequences:
  - Anyone can find out whether an email has an account, through any of these endpoints.
  - Combined with the lockout, anyone can find an account and lock it for 15 minutes.
  - The per-IP and per-account rate limits, the lockout and the security log are the
    remaining defences against guessing.
  - Reverting this means restoring the 2026-10-27 text of this section and of
    "Login, lockout and rate limits".

### Login, lockout and rate limits
- **Login checks, in this order.** The first that fails decides the response:

  | # | Check | Response | Message |
  |---|---|---|---|
  | 1 | No account has the email | `404 ACCOUNT_NOT_FOUND` | "No account found with this email." |
  | 2 | The account is locked | `423 ACCOUNT_LOCKED`, `Retry-After` | "Too many failed attempts. Try again in N minutes." |
  | 3 | No password set yet (bootstrap or `admin:create`, link unused) | `401 PASSWORD_NOT_SET` | "No password is set for this account. Use your set-password link, or reset your password." |
  | 4 | Wrong password | `401 INCORRECT_PASSWORD` | "Incorrect password." |
  | 5 | `UNVERIFIED` | `401 ACCOUNT_NOT_VERIFIED` | "Verify your email before logging in." The page offers resend. |
  | 6 | `DEACTIVATED` | `401 ACCOUNT_DEACTIVATED` | "This account has been deactivated. Contact an admin." |

  - A locked account's password isn't checked.
  - The status is checked after the password.
  - The web app computes N from `Retry-After`, rounded up to whole minutes.
- **Per-account lockout**: 5 consecutive failed logins → locked for 15 minutes.
  - Only check 4 (a wrong password) counts as a failure. The attempt that reaches 5
    returns `423 ACCOUNT_LOCKED` instead of `INCORRECT_PASSWORD`.
  - The counter and `lockedUntil` live on the user row (PostgreSQL), so they hold across
    instances.
  - A successful login resets the counter. A completed reset clears the lock.
  - Accepted trade-off: anyone can find an account (above) and lock it for 15 minutes.
    Per-IP rate limits slow this down, and the owner can always use forgot-password.
- **Rate limits**:
  - login: ≤ 30 per minute per IP (offices share one IP) and ≤ 10 per minute per
    account
  - signup: ≤ 5 per hour per IP and ≤ 3 per hour per email
  - resend-verification and forgot-password: ≤ 3 per hour per email. No per-IP limit
    (amended 2026-11-03, POC scope, owner decision): the per-email limit already caps
    the mail any one address receives.
  - Over any limit → `429 RATE_LIMITED` with `Retry-After`, and nothing is sent.

### Sessions and refresh rotation
- Table `sessions` (one row per refresh family): id, user, created at, last used at (set
  on login and each refresh), **absolute expiry** (`created_at` + 30 days), user agent, IP,
  revoked at, revoke reason.
- **Two lifetimes**:
  - **Idle**: each refresh token is valid for 7 days, so a session unused for 7 days ends.
  - **Absolute**: a session ends 30 days after login, however active it is.
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
  A refresh on a revoked session → `401 SESSION_REVOKED` (amended 2026-11-03, POC scope,
  owner decision):
  - The session row records one of eight revoke reasons (`PASSWORD_CHANGED`,
    `PASSWORD_RESET`, `ROLES_CHANGED`, `DEACTIVATED`, `LOGOUT`, `LOGOUT_ALL`,
    `USER_REVOKED`, `REUSE_DETECTED`), which the security log also carries.
  - Only three are public: `PASSWORD_CHANGED`, `PASSWORD_RESET` and `ROLES_CHANGED` go in
    the problem's `reason`, and the web app shows "You were logged out because <reason>.
    Please log in again."
  - `LOGOUT`, `LOGOUT_ALL`, `USER_REVOKED` and `REUSE_DETECTED` leave `reason` out, and
    the web app shows "You've been logged out. Please log in again." Reuse detection
    still revokes the whole session.
  - `DEACTIVATED` never reaches the user as a reason: a deactivated user's refresh gets
    `401 ACCOUNT_DEACTIVATED` first.
  - Only the holder of that session's refresh token ever sees a reason: no response
    about another user's session carries it.
- **Session management**:
  - `GET /api/auth/sessions` lists the caller's active sessions: id, createdAt,
    lastUsedAt, user agent, IP, and `current: true` on the calling session. It is
    paginated per ADR-0007, sorted by `lastUsedAt` descending, then `id`.
  - `DELETE /api/auth/sessions/:id` revokes one session.
    - Another user's session id → `404`.
    - Revoking the current session also clears its cookies, like logout.
- A revoked session is refused on its next request, whatever its access token's expiry
  (amended 2026-11-03).

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
  - reset password
  - admin-initiated reset (same link, different wording)
- **Emails are sent after the transaction commits, never inside it**. A rolled-back
  command sends nothing.
  - There's no outbox (ADR-0019). If sending fails, the failure is logged
    (`mail_send_failed`) and the user retries with resend-verification or
    forgot-password. Mail shutdown gives up on is logged as `mail_send_abandoned`
    (ADR-0020).
- **Mailpit** runs in docker compose under the `local` profile (SMTP on the internal
  network, web UI on `localhost:8025`). `.env.example` sets `COMPOSE_PROFILES=local`, so
  `docker compose up` still needs only `.env`.
  - A deployment's `.env` leaves the profile unset and points the SMTP settings at a real
    relay.
  - With `APP_ENV=production`, config validation refuses an SMTP host of `mailpit`, so real
    users' emails can never be swallowed by the test inbox.
  - With `APP_ENV=production`, SMTP always runs over TLS: implicit with
    `SMTP_SECURE=true`, otherwise STARTTLS is required. A server that doesn't offer
    STARTTLS (or a man in the middle that strips it) gets neither the credentials nor the
    message, and the send fails as `mail_send_failed`. Mailpit speaks plain text, so
    outside production this isn't required.
- Tests use an in-memory capture adapter. Playwright reads mail through Mailpit's API.

### Deployment
- Same origin: nginx in docker compose serves the frontend and proxies `/api` to the API.
  No CORS is needed, and cross-origin requests are rejected.
- `Secure` cookies work on `http://localhost` (browsers treat it as a secure context). Any
  other deployment terminates TLS at nginx.
- **Rate-limit counters** (amended 2026-11-02): one store, the database, as for the
  lockout. Counters live in a PostgreSQL table, so limits hold across every API instance;
  there is no in-memory option and nothing to configure.

### Security logs
These events are written as structured `security` log entries, separate from the business
audit:
- signup
- email verification
- login success and failure, with the reason: unknown email, locked, no password set,
  wrong password, unverified, deactivated
- lockout
- logout and logout-all
- refresh-reuse detection
- session revoked (with who revoked it and why)
- reset requested and completed
- password changed
- mail send failure

Each entry has the user id when known, IP, user agent, session id and request id. Entries
never contain tokens or passwords. The only exceptions are the set-password
links printed by bootstrap and by `admin:create` (ADR-0016).

### Retention of session and security data (DPDP Act 2023)
- IP addresses and user agents are personal data, kept only as long as they serve
  security.
- Session rows and their refresh tokens are purged **90 days after the session ends**
  (revoked, or past its idle or absolute expiry).
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
- Server-side sessions only (no JWT): the session is read on every request anyway, but
  the signed token still lets a forged or expired one be refused without a database read,
  and gives the web app `ACCESS_TOKEN_EXPIRED` to refresh on.
- Long-lived access tokens: delay deactivation. Rejected.
- **Anti-enumeration** (the decision until 2026-11-02): one `401 INVALID_CREDENTIALS` for
  every login failure, `202` from signup, resend and forgot-password whatever the account,
  a dummy argon2id hash for unknown emails, and a 400 ms minimum response time. It hid
  which emails have accounts, at the cost of vague messages. Replaced for this POC by
  specific codes (owner decision).

## Tests
- Signup and verification:
  - a disallowed domain → 400 `SIGNUP_DOMAIN_NOT_ALLOWED`; domain matching is
    case-insensitive
  - a duplicate signup → 409 `EMAIL_IN_USE`, for each status; no user is created and
    nothing is sent
  - an unverified user with the right password → 401 `ACCOUNT_NOT_VERIFIED`
  - verify → `ACTIVE`
  - resend-verification: an unknown email → 404 `ACCOUNT_NOT_FOUND`; an active account →
    409 `ACCOUNT_ALREADY_VERIFIED`; a deactivated one → 401 `ACCOUNT_DEACTIVATED`; nothing
    is sent in any of them
  - self-signup always gets `{}`; `roles` in the body → 400
  - a verified no-role user can log in and gets `403 NO_ROLE_ASSIGNED` everywhere except
    `/me`, password, sessions, logout and the access request
- Tokens: expired → `TOKEN_EXPIRED`, used → `TOKEN_USED`, superseded →
  `TOKEN_SUPERSEDED`, unknown or wrong purpose → `INVALID_TOKEN`; a used and expired token
  → `TOKEN_USED`; a new token invalidates the previous one with the same purpose; the
  database stores only the hash.
- Passwords:
  - policy field codes
  - change-password revokes the other sessions and keeps the current one
  - a wrong current password → 400 `INCORRECT_PASSWORD`
  - a new password equal to the current one → 400 `PASSWORD_UNCHANGED`, nothing written
  - forgot-password: an unknown email → 404 `ACCOUNT_NOT_FOUND`; a deactivated account →
    401 `ACCOUNT_DEACTIVATED`; nothing is sent in either
  - reset-password revokes all sessions, clears a lockout and activates an `UNVERIFIED`
    user
- Lockout:
  - 4 wrong passwords → 401 `INCORRECT_PASSWORD` each; the 5th → 423 `ACCOUNT_LOCKED`
    with `Retry-After`; a 6th attempt with the right password → the same 423
  - unlocked after 15 minutes (with an injected clock)
  - the counter resets on success
  - lockout holds across two app instances
- Rate limits: signup per IP and per email, resend and forgot-password per email → 429
  `RATE_LIMITED` with `Retry-After`, and nothing is sent.
- Sessions:
  - the list shows only the caller's sessions and marks the current one
  - revoking a session → that session's next request and refresh → 401 `SESSION_REVOKED` with no
    `reason`; each revoke path stores its own reason in the session row
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
  - reuse of a rotated token after 10 s → whole session revoked (`REUSE_DETECTED` stored
    and logged) → 401 `SESSION_REVOKED` with no `reason`
  - a password change, reset or role change → the session's next request and refresh → 401
    `SESSION_REVOKED` with that `reason`
  - concurrent refreshes within 10 s both succeed (sibling tokens) and the session stays
    valid
- Logout:
  - logout with an expired access token still revokes the session
  - logout-all revokes every session
- Cookies:
  - the refresh cookie is not sent to non-auth `/api` routes (Path asserted)
  - flags asserted (HttpOnly, Secure, SameSite=Strict, Path), and no token in any response
    body
- The rate limiter keeps its counters in PostgreSQL: two app instances share one limit.
- A deactivated user's next request → 401 `ACCOUNT_DEACTIVATED`. A removed role → next
  request 403.
- Access tokens: an expired one → 401 `ACCESS_TOKEN_EXPIRED`; none, a malformed one, or one
  signed with another key → 401 `UNAUTHENTICATED`.
- CSRF:
  - a missing or wrong CSRF token → 403 `CSRF_REJECTED`
  - a cross-origin `Origin` → 403, on public endpoints as well
  - after a simulated browser restart (session cookies dropped), refresh succeeds and the
    next state-changing request passes the CSRF check
- Login: the 31st attempt in a minute from one IP → 429, and the 11th on one account →
  429 (even from different IPs). Each row of the login check table returns its own code,
  and the first failing check wins:
  - a locked account with the right password → 423 `ACCOUNT_LOCKED`
  - an unverified or deactivated account with a wrong password → 401
    `INCORRECT_PASSWORD`
  - an account with no password set (bootstrap or CLI-created, link unused) → 401
    `PASSWORD_NOT_SET`, and no failure is counted
- Security log events are emitted for each event listed, without secrets.
