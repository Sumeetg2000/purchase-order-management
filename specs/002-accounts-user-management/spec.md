# Feature Specification: Slice 1 — Accounts and user management

**Feature Branch**: `002-accounts-user-management`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "Slice 1: Accounts and user management. Build per the
constitution's slice order, from docs/BRIEF.md and the ADRs as amended on 2026-11-02
(ADR-0016 users and audit, ADR-0017 authentication/sessions/CSRF with specific auth error
codes and ACCESS_TOKEN_EXPIRED and no anti-enumeration, ADR-0018 frontend auth flow and
account pages, ADR-0004 authorization and check precedence, ADR-0007 error registry and
body-schema inventory). Scope: restricted signup with email verification and no initial
role; login with the ordered specific failure codes, per-account lockout and rate limits;
cookie sessions (JWT access, rotating refresh with reuse detection and 10 s sibling grace,
CSRF); logout, logout-all, session list and revoke; change, forgot and reset password;
profile (/me); access requests from no-role users; admin user management (list, roles,
deactivate/reactivate, admin-initiated reset); security logs; session and security-data
purge; the frontend account pages and auth flow. Every new area follows CLAUDE.md layering
(routes → service → repository)."

## Context

The brief requires that every action is tied to a real, authenticated user, with no
anonymous path (§6). This slice delivers those users: how they get an account, prove who
they are, stay logged in safely, and how an administrator gives them the right to work.
It delivers no procurement feature. Vendors arrive in slice 2 and orders in slice 3.

The users are:
- a **new employee**, who signs up with a company email and waits for a role
- a **Buyer** or **Approver**, who logs in, keeps a profile and manages their sessions
- a **Procurement Admin**, who assigns roles, deactivates leavers and answers access
  requests
- an **operator** with shell access, who manages administrator accounts

The binding documents are the [constitution](../../.specify/memory/constitution.md), the
ADRs in [docs/adr/](../../docs/adr/README.md) (as amended on 2026-11-02), and
[docs/BRIEF.md](../../docs/BRIEF.md). This spec states *what* must be true. ADR-0016 and
ADR-0017 record the mechanisms and numbers, and this spec points to them instead of
repeating every one.

**Error messages are specific** (owner decision, 2026-11-02, ADR-0017 "Specific failures
over anti-enumeration"). Every failure tells the user exactly what went wrong, including
whether an email has an account. ADR-0018's account-page text and the `NFR-FE-08`
traceability row still described the earlier neutral confirmations; both are corrected
with this spec to match the decision.

## Clarifications

### Session 2026-11-02

- Q: Where do rate-limit counters live? → A: Always in PostgreSQL, as the lockout does. No
  configurable store and no in-memory option (FR-016; ADR-0017 amended).

### Session 2026-11-03

- Q: What does a failed one-time link return? → A: One code per cause: `TOKEN_EXPIRED`,
  `TOKEN_USED`, `TOKEN_SUPERSEDED`, and `INVALID_TOKEN` only for an unknown token
  (FR-002, FR-015; ADR-0007 and ADR-0017 amended).
- Q: What does `SESSION_REVOKED` tell the user? → A: Why, for the three public reasons
  only (password changed, password reset, roles changed): "You were logged out because
  <reason>. Please log in again." Every other revocation, reuse detection included, shows
  "You've been logged out. Please log in again." Never for another user's session
  (FR-008, FR-033; amended the same day, POC scope, owner decision).
- Q: What is cut for the POC? → A: Owner decision, recorded as "POC scope" ADR amendments:
  no phone field (so no phone purge, phone-leak scans or `INVALID_PHONE`); no cross-tab
  refresh coordination; no 10,000-user seed or committed query plans in this slice
  (slice 7 owns them; the indexes stay); resend-verification and forgot-password limited
  per email only. `admin:reactivate` stays, since `admin:create` refuses an existing
  email.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Log in, stay logged in, log out (Priority: P1)

A user with a password logs in with their email and password, works without being
interrupted while their session is valid, and logs out. Every failed login says exactly
why. The bootstrap administrator, who has no password yet, sets one through their
one-time link and then logs in.

**Why this priority**: Nothing else in the product can be used without it, and the brief
forbids any anonymous path (§6). It also gives the existing bootstrap administrator a way
in, so the slice is demonstrable from the first story.

**Independent Test**: Start the stack, open the bootstrap administrator's set-password
link, set a password, log in, call an authenticated endpoint, let the access token
expire and confirm the next call succeeds after a silent refresh, then log out and
confirm the next call is refused.

**Acceptance Scenarios**:

1. **Given** an active user with a password, **When** they log in with the right
   password, **Then** they are logged in, the session cookies are set with the flags in
   ADR-0017, and no token appears in any response body.
2. **Given** a login attempt, **When** it fails, **Then** the first failing check in
   ADR-0017's order decides the response: unknown email → `404 ACCOUNT_NOT_FOUND`; locked
   → `423 ACCOUNT_LOCKED` with `Retry-After`; no password set → `401 PASSWORD_NOT_SET`;
   wrong password → `401 INCORRECT_PASSWORD`; unverified → `401 ACCOUNT_NOT_VERIFIED`;
   deactivated → `401 ACCOUNT_DEACTIVATED`. The login page shows each code's message.
3. **Given** an account, **When** a fifth consecutive wrong password is entered, **Then**
   the response is `423 ACCOUNT_LOCKED` with `Retry-After`, and for 15 minutes even the
   right password gets the same response. A successful login resets the count.
4. **Given** one client address, **When** it makes a 31st login attempt within a minute,
   or any addresses make an 11th attempt on one account within a minute, **Then** the
   attempt gets `429 RATE_LIMITED` with `Retry-After`.
5. **Given** a logged-in user whose access token has expired, **When** they call any
   endpoint, **Then** the API answers `401 ACCESS_TOKEN_EXPIRED`, the web app refreshes
   once and retries the call, and the user notices nothing.
6. **Given** a request with no access token, or a malformed or wrongly signed one,
   **When** it reaches any non-public endpoint, **Then** it gets `401 UNAUTHENTICATED`,
   and the web app sends the user to login without trying a refresh.
7. **Given** a session past its 7-day idle limit or its 30-day absolute limit, **When**
   the web app refreshes, **Then** it gets `401 SESSION_EXPIRED`, shows "Your session has
   expired. Please log in again." and goes to login, keeping the page to return to.
8. **Given** a refresh token that was already rotated, **When** it is presented more than
   10 seconds after its rotation, **Then** the whole session is revoked and the response
   is `401 SESSION_REVOKED`, with no reason given. **When** it is presented
   within 10 seconds (several tabs
   refreshing at once), **Then** each request gets a new token and the session stays
   valid.
9. **Given** a logged-in user, **When** they log out, even with an expired access token,
   **Then** that session is revoked and its cookies are cleared.
10. **Given** a state-changing request, **When** its CSRF token is missing or wrong, or
    its `Origin` is not the app's, **Then** it gets `403 CSRF_REJECTED`. After a browser
    restart that drops session cookies, a refresh still succeeds and the next
    state-changing request passes the CSRF check.
11. **Given** the bootstrap or a CLI-created administrator who hasn't set a password,
    **When** they open their set-password link and set a valid password, **Then** they can
    log in. Before that, login gets `401 PASSWORD_NOT_SET`.

---

### User Story 2 - Sign up, verify, and ask for access (Priority: P1)

A new employee signs up with their company email and a password. They verify their email
from the message they receive, log in, and land on an "Access pending" screen, because a
new account has no role. From there they send the administrator a short message asking
for access, and later see whether it was handled.

**Why this priority**: It's how every non-admin user enters the system. Without it, only
operator-created administrators exist.

**Independent Test**: Sign up with an allowed domain, open the verification email in the
test inbox, verify, log in, confirm the Access pending screen appears and every other
feature is refused with `NO_ROLE_ASSIGNED`, and send an access request.

**Acceptance Scenarios**:

1. **Given** an email whose domain is allowed (case-insensitive), **When** someone signs
   up with a valid password, **Then** an unverified account with no role is created, a
   verification email is sent, and the response is `202`.
2. **Given** an email whose domain is not allowed, **When** someone signs up, **Then** it
   gets `400 SIGNUP_DOMAIN_NOT_ALLOWED`.
3. **Given** an email that already has an account, in any status, **When** someone signs
   up with it, **Then** it gets `409 EMAIL_IN_USE`, whose message points to login and
   forgot-password, and nothing is created or sent.
4. **Given** a signup body containing roles, status or any other unknown field, **When**
   it is sent, **Then** it gets `400` and nothing is created.
5. **Given** a valid verification link, **When** the user opens it, **Then** the page
   removes the token from the address bar and asks "Enter the password you chose to
   confirm your email"; with the signup password the account becomes active, and it does
   not log the user in. An expired link → `400 TOKEN_EXPIRED`, a used one →
   `400 TOKEN_USED`, a superseded one → `400 TOKEN_SUPERSEDED`, an unknown one →
   `400 INVALID_TOKEN`; then a deactivated account → `401 ACCOUNT_DEACTIVATED`, a locked
   one → `423 ACCOUNT_LOCKED`. A wrong password → `400 VALIDATION_FAILED` with
   `INCORRECT_PASSWORD` on `body.password`: nothing is activated, it counts toward the
   lockout like login, and the link stays usable. *Amended 2026-11-05 (owner decision,
   ADR-0017 "Squatting").*
5a. **Given** someone signed up first with another person's address, **When** the
   address's owner uses forgot-password and the reset link, **Then** the account becomes
   active with the owner's password, and the squatter's password no longer works. The
   verification email tells the owner they can do this. *Added 2026-11-05.*
6. **Given** resend-verification, **When** it is asked for an unverified account, **Then**
   a new link is sent (`202`) and the earlier one stops working. Unknown email →
   `404 ACCOUNT_NOT_FOUND`; verified account → `409 ACCOUNT_ALREADY_VERIFIED`; deactivated
   → `401 ACCOUNT_DEACTIVATED`; nothing is sent in those cases.
7. **Given** a verified user with no role, **When** they log in, **Then** they see the
   Access pending screen with their signup date. Every endpoint other than their profile,
   password, sessions, logout and access request answers `403 NO_ROLE_ASSIGNED`, before
   any input validation, and the web app routes that code to Access pending.
8. **Given** a no-role user, **When** they send an access request (1–500 characters of
   plain text), **Then** an open request is created. Sending again updates the same open
   request's message. A fourth send in one day → `429`. A user who has a role → `403`.
9. **Given** a user's request was dismissed with a note, **When** they open Access
   pending, **Then** they see the note rendered as text, and they can send a new request.

---

### User Story 3 - Administer users and access requests (Priority: P1)

A Procurement Admin finds users by name, email, role or status, assigns or changes their
role set, deactivates leavers, reactivates returners, sends password reset emails, and
works through the open access requests.

**Why this priority**: A signed-up user can do nothing until an admin assigns a role
(ADR-0016). This story completes the path from signup to a working Buyer or Approver.

**Independent Test**: As an admin, find a no-role user from their open access request,
assign Buyer, confirm the request is resolved and the user's sessions end, then deactivate
the user and confirm they can't log in and their next request is refused.

**Acceptance Scenarios**:

1. **Given** the admin Users screen, **When** the admin filters by role (including "No
   role"), status or a name/email prefix, **Then** the paginated list shows only matching
   users, sorted by name then id, with their last login time, and the filters are kept in
   the URL.
2. **Given** a user, **When** the admin assigns one of the three sets (Buyer, Approver,
   Buyer + Approver), **Then** the role set changes, all of the user's sessions end, a
   `USER_ROLES_CHANGED` audit entry records before and after, and the user's open access
   request, if any, is resolved in the same change.
3. **Given** an admin update, **When** it names any other role set, including no role or
   Admin, or any other field, **Then** it gets `400`. **When** it carries no version →
   `400 VERSION_REQUIRED`; a stale version → `409 VERSION_CONFLICT`.
4. **Given** an admin update, **When** its target is the admin themself → `409
   SELF_MODIFICATION`; another admin → `409 ADMIN_NOT_MODIFIABLE`; activating an
   unverified user → `409 USER_UNVERIFIED`, in that order.
5. **Given** an active user, **When** the admin deactivates them, **Then** all their
   sessions end, their next request gets `401 ACCOUNT_DEACTIVATED`, login with the right
   password gets `401 ACCOUNT_DEACTIVATED`, and an open access request is dismissed with
   the note "Account deactivated".
6. **Given** an update that changes nothing, **When** it is sent, **Then** nothing is
   written: no audit entry and no session ends.
7. **Given** a user, **When** the admin sends a password reset, **Then** the standard
   reset email goes out (`202`), a `USER_PASSWORD_RESET_SENT` audit entry is written, and
   the admin never sees a password or token. A deactivated user gets `409
   USER_DEACTIVATED` and no email; a reset link used after its account was deactivated
   gets `401 ACCOUNT_DEACTIVATED` and stays unused (owner decision 2026-11-04).
8. **Given** the Access requests tab, **When** the admin dismisses an open request with a
   note, **Then** the user sees the note. Dismissing a request that isn't open → `409
   ACCESS_REQUEST_NOT_OPEN`. Admins see an open-request count badge on Users.
9. **Given** any user who is not an admin, **When** they call an admin endpoint, **Then**
   it is refused (`403`, or `403 NO_ROLE_ASSIGNED` for a no-role user).

---

### User Story 4 - Profile, password and sessions (Priority: P2)

Any logged-in user, with or without a role, views their profile, edits their name,
changes their password, sees where they're logged in, and ends a session or all of
them.

**Why this priority**: Users need to keep their details right and react to a lost device,
but the product works without it for a first demo.

**Independent Test**: Log in from two browsers, edit the name, change the
password and confirm the other browser is logged out, then revoke a session from the list
and log out everywhere.

**Acceptance Scenarios**:

1. **Given** a logged-in user, **When** they open their profile, **Then** they see id,
   name, email, roles, status and signup date, with email, roles and status
   read-only.
2. **Given** a profile edit, **When** it sets a name (1–100 characters), **Then** it is
   saved and audited as `USER_PROFILE_UPDATED`, recording the name before and after.
   Email, roles, status or any other field (`phone` included) → `400`.
3. **Given** a password change, **When** the current password is wrong, **Then** it gets
   `400` with field code `INCORRECT_PASSWORD` and counts toward the lockout. A new
   password shorter than 12, longer than 128 or on the common-password list gets
   `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG` or `PASSWORD_TOO_COMMON`. Once the current
   password is verified, a new password equal to it gets `400` with field code
   `PASSWORD_UNCHANGED` on `newPassword` ("Your new password must be different from your
   current one."); nothing is written and no session ends.
4. **Given** a successful password change, **Then** every other session of the user ends
   and the current one stays.
5. **Given** the sessions list, **When** the user opens it, **Then** it shows only their
   own active sessions (device, address, created and last used), marks the current one,
   and is paginated. Another user's session id → `404`.
6. **Given** a revoked session, **When** that browser next refreshes, **Then** it gets
   `401 SESSION_REVOKED`, sees "You've been logged out. Please log in again." and is sent
   to login. Revoking the current session also clears
   its cookies.
7. **Given** "Log out everywhere", **When** the user confirms, **Then** every session of
   the user ends, this one included.

---

### User Story 5 - Forgot and reset a password (Priority: P2)

A user who forgot their password asks for a reset link, sets a new password from the
email, and logs in. Completing a reset also proves they own the mailbox.

**Why this priority**: Needed before real users rely on the system, and it's the recovery
path for a lockout, an expired bootstrap link and a squatted signup.

**Independent Test**: Ask for a reset for an existing account, open the email in the test
inbox, set a new password, and confirm every old session ended and the new password works.

**Acceptance Scenarios**:

1. **Given** forgot-password, **When** it is asked for an unverified or active account,
   **Then** a reset email is sent (`202`) and any earlier unused reset link stops working.
   Unknown email → `404 ACCOUNT_NOT_FOUND`; deactivated → `401 ACCOUNT_DEACTIVATED`;
   nothing is sent in those cases.
2. **Given** a valid reset link, **When** the user sets a valid new password, **Then** it
   is saved, every session of the user ends, any lockout is cleared, an unverified
   account becomes active, and the user then logs in.
3. **Given** a reset link that is expired (30 minutes), used, superseded or unknown,
   **When** it is used, **Then** it gets `400 TOKEN_EXPIRED`, `TOKEN_USED`,
   `TOKEN_SUPERSEDED` or `INVALID_TOKEN` respectively, each with its own message.
4. **Given** signup (limited per client address and per email) or resend-verification
   or forgot-password (per email only), **When** a limit in ADR-0017 is exceeded, **Then** it gets `429 RATE_LIMITED` with
   `Retry-After`, and nothing is sent.

---

### User Story 6 - Operator manages administrator accounts (Priority: P3)

An operator with shell access deactivates an administrator who left, or reactivates one,
from the server's command line. The API never lets an admin change another admin.

**Why this priority**: Rare, but without it a departed administrator keeps access.
Creating admins already exists (slice 0).

**Independent Test**: With two active admins, deactivate one from the command line,
confirm their sessions end and they can't log in, reactivate them, and confirm the last
active admin can't be deactivated.

**Acceptance Scenarios**:

1. **Given** two active admins, **When** the operator deactivates one, **Then** that
   admin's sessions all end, and it is audited as `USER_DEACTIVATED` with actor type
   operator, OS user and host.
2. **Given** one active admin, **When** the operator tries to deactivate them, **Then**
   it fails with `LAST_ADMIN` and nothing changes. Two concurrent deactivations of the
   last two admins leave one active.
3. **Given** a non-admin email, **When** either command is run, **Then** it fails with
   `NOT_AN_ADMIN`. Reactivating an active admin changes nothing and exits successfully.

---

### User Story 7 - Retention, privacy and security records (Priority: P3)

Security events are recorded separately from the business audit, without secrets. Old
session data and ended rate-limit windows are removed on schedule.

**Why this priority**: Required by the constitution and DPDP retention rules, but not on
any user's path.

**Independent Test**: Trigger each security event and check its log entry, then run the
purge with an injected clock and confirm only data past its limit is removed.

**Acceptance Scenarios**:

1. **Given** each event in ADR-0017's security-log list, **When** it happens, **Then** a
   structured security log entry is written with the user id when known, address, user
   agent, session id and request id, and with no token or password.
2. **Given** sessions that ended more than 90 days ago, **When** the daily purge runs,
   **Then** they are deleted with their refresh tokens, and newer ones stay.
3. **Given** rate-limit windows that have ended, **When** the purge runs, **Then** they
   are deleted, and the current windows stay.

### Edge Cases

- **Two tabs refresh at once**: each tab refreshes on its own (no cross-tab
  coordination, ADR-0018 amended 2026-11-03), and both succeed through the 10-second
  sibling window.
- **A role change while the user is mid-session**: the change ends their sessions, and
  their very next request gets `401 SESSION_REVOKED` with the reason, because every
  request reads its session (ADR-0017 amended 2026-11-03).
- **Logged out or revoked elsewhere**: the old access token gets `401 SESSION_REVOKED` on
  its next request, not 15 minutes later.
- **A refresh that fails for a passing reason** (no network, a server error): the session
  stays; the waiting calls fail with that error and the next call tries again.
- **Deactivated while holding a valid access token**: the next request gets
  `401 ACCOUNT_DEACTIVATED` (status loads on every request), not a 15-minute grace.
- **Squatted signup**: someone signs up with a colleague's address first. The account
  stays unverified. The real owner gets `EMAIL_IN_USE`, uses forgot-password, and
  completing the reset sets their password and verifies the account.
- **Locked account and forgot-password**: a completed reset clears the lockout.
- **Expired bootstrap link**: the admin uses forgot-password.
- **The only Approver is given Buyer + Approver**: the role dialog warns that their own
  orders above the threshold can't be approved (ADR-0002); the change is allowed.
- **Mail server down**: signup, resend, forgot-password and admin reset still succeed;
  the send failure is logged (`mail_send_failed`), and the user retries with resend or
  forgot-password.
- **Rate-limit counters across instances**: limits hold across API instances (see
  FR-016).
- **Clock-based limits** (lockout, idle and absolute session limits, token expiry, purge
  ages) are tested with an injected clock.

## Requirements *(mandatory)*

Each requirement traces to a row in [docs/traceability.md](../../docs/traceability.md).
"Part" means this slice delivers part of that row, and the rest lands in the slice noted.

### Functional Requirements

**Signup and verification**
- **FR-001**: Signup MUST accept only name, email and password (strict body), accept only
  emails whose domain is in the configured allowlist (case-insensitive), create an
  unverified account with no role, send a verification email, and return `202`. A
  disallowed domain → `400 SIGNUP_DOMAIN_NOT_ALLOWED`; an email that has an account →
  `409 EMAIL_IN_USE`, with nothing created or sent. *(FR-ACC-01)*
- **FR-002**: Verification MUST activate the account from a valid one-time link and not
  log the user in. Resend-verification MUST behave as in User Story 2, scenario 6.
  Verification links are valid 24 hours, single use, and superseded by a newer link. A
  failed link gets its own code: `TOKEN_EXPIRED`, `TOKEN_USED`, `TOKEN_SUPERSEDED`, or
  `INVALID_TOKEN` for an unknown token. *(FR-ACC-02, FR-ACC-03)*

**Login, lockout and rate limits**
- **FR-003**: Login MUST apply ADR-0017's checks in order, returning the first failing
  check's code and message: `ACCOUNT_NOT_FOUND`, `ACCOUNT_LOCKED` (with `Retry-After`;
  password not checked), `PASSWORD_NOT_SET`, `INCORRECT_PASSWORD`, `ACCOUNT_NOT_VERIFIED`,
  `ACCOUNT_DEACTIVATED`. Passwords MUST be stored only as hashes, as ADR-0017 specifies.
  *(NFR-SEC-05, FR-ADM-05
  part: the CLI-created admin's `PASSWORD_NOT_SET`)*
- **FR-004**: Five consecutive wrong passwords MUST lock the account for 15 minutes; the
  attempt that reaches five returns `423 ACCOUNT_LOCKED`. Only wrong passwords count.
  Success resets the count; a completed reset clears the lock. Lockout state MUST be
  shared by every API instance. *(NFR-SEC-07)*
- **FR-005**: Rate limits MUST apply as in ADR-0017: login ≤ 30 per minute per client
  address and ≤ 10 per minute per account; signup ≤ 5 per hour per address and ≤ 3 per
  hour per email; resend-verification and forgot-password ≤ 3 per hour per email, with no
  per-address limit (ADR-0017, amended 2026-11-03). Over any limit → `429 RATE_LIMITED` with `Retry-After`, and
  nothing is sent. *(NFR-SEC-05, NFR-SEC-08)*
- **FR-016**: Rate-limit counters MUST hold across every API instance. They live in
  one store, the database, as the lockout does: there is no in-memory option and nothing
  to configure (ADR-0017, amended 2026-11-02). *(NFR-SEC-05)*

**Sessions, tokens and CSRF**
- **FR-006**: A successful login MUST set the access, refresh and CSRF cookies with the
  content, lifetime, flags and paths in ADR-0017. No auth token is ever in a response
  body or readable by page scripts. *(NFR-SEC-01)*
- **FR-007**: Every non-public endpoint MUST require a valid access token: none,
  malformed or wrongly signed → `401 UNAUTHENTICATED`; expired → `401
  ACCESS_TOKEN_EXPIRED`. Status and roles MUST be loaded on every request: a user who is
  no longer active → `401 ACCOUNT_DEACTIVATED`; a missing role → `403`. *(NFR-AUTH-01,
  NFR-SEC-03)*
- **FR-008**: Refresh MUST rotate the refresh token within the same session, with reuse
  detection and the 10-second sibling window from ADR-0017. Reuse after the window
  revokes the session (`401 SESSION_REVOKED`). An expired refresh token or a session past
  its absolute limit → `401 SESSION_EXPIRED`; a revoked session → `401 SESSION_REVOKED`
  carrying `reason` only when the revoke reason is public (password changed, password
  reset, roles changed), so the web app can say why. The reason is only ever returned to the holder of that session's refresh token,
  never for another user's session. Every request checks its session too, in the same
  order, so a revoked session is refused on its next request (ADR-0017 amended
  2026-11-03). *(NFR-SEC-02, NFR-SEC-03)*
- **FR-009**: A session MUST end after 7 days unused or 30 days after login, whichever
  comes first. Rotation never extends the 30-day limit, and each refresh cookie's lifetime
  matches. *(NFR-SEC-09)*
- **FR-010**: Every state-changing request MUST pass the same-site cookie rule, the
  `Origin` check and the session-bound CSRF header; failure → `403 CSRF_REJECTED`. The
  public account endpoints rely on the `Origin` check and same-site cookies. The CSRF
  cookie MUST live as long as the refresh cookie and be re-issued with it. *(NFR-SEC-04)*
- **FR-011**: Logout MUST revoke the session identified by the refresh token itself (so it
  works with an expired access token) and clear the cookies. Logout-all MUST revoke every
  session of the user. *(NFR-SEC-03)*
- **FR-012**: A user MUST be able to list their own active sessions (paginated, sorted by
  last use, then id, current one marked) and revoke one. Another user's session id →
  `404`. *(FR-ACC-06)*
- **FR-013**: Every role change, deactivation and completed password reset MUST end all
  of the user's sessions; a password change MUST end every other session. *(NFR-SEC-03,
  FR-ACC-04, FR-ACC-05, FR-ACC-07)*

**Passwords**
- **FR-014**: Passwords MUST be 12–128 characters and not on a bundled common-password
  list, checked offline, with field codes `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG` and
  `PASSWORD_TOO_COMMON`. Change-password MUST require the current password (wrong →
  `400` field code `INCORRECT_PASSWORD`, rate-limited and counted like login).
  *(FR-ACC-04)*
- **FR-015**: Forgot-password and reset-password MUST behave as in User Story 5. Reset
  links are valid 30 minutes, single use and superseded by a newer link. Admins never set
  or see a password. *(FR-ACC-05, FR-ACC-03)*

**Authorization**
- **FR-017**: Every route MUST declare its access level: public, any logged-in user
  (including no role), or specific roles. Startup and the automated checks MUST fail for
  a route without one. *(NFR-AUTH-01)*
- **FR-018**: A no-role user MUST be able to use only their profile, password, sessions,
  logout and access request. Every other endpoint MUST answer `403 NO_ROLE_ASSIGNED`
  before input validation (ADR-0004 precedence). *(FR-ACC-08)*
- **FR-019**: The authorization matrix MUST be tested cell by cell, generated from the
  route table: every endpoint of this slice × Buyer, Approver, Buyer + Approver, Admin,
  no role, and anonymous. *(NFR-AUTH-02)*

**Profile and access requests**
- **FR-020**: `/me` MUST return id, name, email, roles, status and signup date, and
  accept edits to the name only, as in User Story 4. *(FR-USR-01)*
- **FR-021**: *Withdrawn 2026-11-03 (POC scope, owner decision): no phone is stored
  (ADR-0016).*
- **FR-022**: Access requests MUST behave as in ADR-0016: no-role users only, one open
  request per user, message updates, 3 per day, status and admin note readable by the
  user, text never rendered as HTML. *(FR-ACC-09)*

**Administration**
- **FR-023**: Admins MUST be able to list users with role (including no role), status
  and name/email prefix filters, paginated, sorted by name then id, with last login time,
  backed by indexes. The committed query plans at 10,000 users land in slice 7
  (ADR-0016, amended 2026-11-03). *(FR-ADM-01)*
- **FR-024**: Admins MUST be able to change a user's role set to one of the three
  assignable sets and activate or deactivate them, with a required version, the guards
  and their order from ADR-0016, no-op detection, and one audit entry per change.
  Assigning a role resolves the user's open access request in the same transaction;
  deactivating dismisses it with "Account deactivated". *(FR-ADM-02, FR-ACC-07 part —
  the order-level effects of removing a role land with orders in slices 3–6)*
- **FR-025**: Admins MUST be able to send a user the standard reset email (`202`,
  audited `USER_PASSWORD_RESET_SENT`), except a deactivated one (`409 USER_DEACTIVATED`,
  nothing sent). *(FR-ADM-03)*
- **FR-026**: Admins MUST be able to list access requests (paginated, status filter,
  committed query plan) and dismiss an open one with an optional note (0–500 characters).
  A request that isn't open → `409 ACCESS_REQUEST_NOT_OPEN`. *(FR-ADM-06)*
- **FR-027**: The operator command line MUST provide `admin:deactivate` and
  `admin:reactivate` with the rules, lock, codes (`LAST_ADMIN`, `NOT_AN_ADMIN`) and
  operator audit in ADR-0016. Deactivation ends the admin's sessions. *(FR-ADM-05)*

**Audit, security logs and retention**
- **FR-028**: The user audit events in ADR-0016 (`USER_SIGNED_UP`, `USER_EMAIL_VERIFIED`,
  `USER_PROFILE_UPDATED`, `USER_ROLES_CHANGED`, `USER_DEACTIVATED`, `USER_REACTIVATED`,
  `USER_PASSWORD_RESET_SENT`, `ACCESS_REQUESTED`, `ACCESS_REQUEST_RESOLVED`,
  `ACCESS_REQUEST_DISMISSED`) MUST be written in the same
  transaction as their change, with the payloads in the catalogue. *(NFR-AUD-04 part —
  their visibility in the Admin organisation-wide log lands with that log)*
- **FR-029**: The security events in ADR-0017 MUST be written as structured security log
  entries, separate from the audit, with no token or password. *(NFR-SEC-06)*
- **FR-030**: The daily purge MUST delete sessions (with their refresh tokens) that ended
  more than 90 days ago, and rate-limit windows that have ended, as in ADR-0017 and
  ADR-0020. The maintenance role MUST be able to delete only those.
  *(NFR-OPS-05 part — idempotency keys land in slice 3)*

**Errors, contract and web app**
- **FR-031**: Every new code MUST be added to the single error registry with its status,
  and to the web app's message map, which stays complete for every code. *(NFR-API-01,
  NFR-FE-01)*
- **FR-032**: Every new mutating endpoint MUST be added to the reviewed body-schema
  inventory; endpoints with no input of their own are listed as taking no body.
  *(NFR-VAL-01)*
- **FR-033**: The web app MUST refresh only on `ACCESS_TOKEN_EXPIRED`, single-flight
  within a tab (tabs are not coordinated); retry each queued request once; show the
  session-expired message and go to login with the return page on `SESSION_EXPIRED`;
  on `SESSION_REVOKED`, show "You were logged out because <reason>. Please log in
  again." for a `reason`, or "You've been logged out. Please log in again." without one,
  and go to login the same way, whether a refresh or any other call answered it; go to
  login with its message on `ACCOUNT_DEACTIVATED`; and keep the session when a refresh
  fails for any other reason (no network, a server error). *(NFR-FE-02)*
- **FR-034**: The web app MUST provide the screens in ADR-0018 for this slice: login,
  signup, verify-email, forgot-password, reset-password (also the set-password page),
  Access pending, profile (with password and sessions), and admin Users with the Access
  requests tab and its badge. Account pages MUST show each outcome's specific message.
  Pages that receive a token post it once and remove it from the address bar. *(NFR-FE-08
  part — the Approvers' pending-approvals count lands in slice 4)*
- **FR-035**: The confirmation dialogs in ADR-0018 for this slice MUST be used: change
  role, deactivate, reactivate, send password reset, dismiss access request, log out
  everywhere, revoke a session, change password. *(NFR-FE-09 part)*
- **FR-036**: The end-to-end tests MUST cover: login and silent refresh; logout; signup →
  verification email → verify → login → Access pending → access request → admin assigns
  a role → user logs in to the Buyer home; dismissal with a note; forgot → reset; profile
  edit, password change and session revoke; admin role change and deactivation.
  *(NFR-FE-07 part, NFR-OPS-01 part: login)*

**Demo data**
- **FR-037**: With demo seeding on (never in production), the migrate step MUST create
  demo Buyers and one Approver, never an admin, idempotently. *(NFR-OPS-01 part)*

### Key Entities

- **User** (completed from slice 0): name, email (lower-case, unique, never changed),
  role set (no role, Buyer, Approver, Buyer + Approver, or Admin), status
  (unverified, active, deactivated) with its deactivation date, a version for admin
  updates, last login time, password hash, and lockout bookkeeping.
- **Session**: one login on one device. It has a creation time, last use, an absolute
  expiry 30 days after login, the device's user agent and address, and, once ended, when
  and why it was revoked.
- **Refresh token**: one link in a session's rotation chain, stored only as a hash, with
  an expiry and the time it was rotated.
- **One-time token** (from slice 0): now also used for email verification.
- **Access request**: a no-role user's message to the administrators, with a status
  (open, resolved, dismissed), dates, and an optional admin note.
- **Rate-limit counter**: attempts per client address or per email within a window.
- **Security log entry**: an authentication event, written to the logs, not the audit.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new employee goes from signup to the Access pending screen, including
  email verification, in under 3 minutes.
- **SC-002**: An admin assigns a role from an open access request in under 1 minute, and
  the user's next login lands on the role's home screen.
- **SC-003**: 100% of failed logins, signups, resends and resets in the test suite return
  the specific code listed for their cause, and each code has a user message.
- **SC-004**: A user working continuously for 8 hours is never asked to log in again,
  while a session unused for 7 days, or 30 days old, always is.
- **SC-005**: Every endpoint × role cell in the authorization matrix, plus anonymous, is
  tested, with zero cells untested.
- **SC-006**: A deactivated user is refused on their very next request, with no grace
  period.
- **SC-007**: Across the whole test suite, zero log lines, audit entries or
  non-admin responses contain a password or token (the two set-password
  links excepted).
- **SC-008**: *Moved to slice 7 (POC scope, owner decision 2026-11-03)*: the admin user
  list answers with the first page in under 200 ms at 10,000 users, shown by committed
  query plans.
- **SC-009**: Every screen added in this slice has zero automated accessibility
  violations.

## Assumptions

- **Error messages**: the specific codes and messages of ADR-0017's 2026-11-02
  amendment apply everywhere, including the account pages; ADR-0018 and `NFR-FE-08` are
  corrected to match.
- **Signup domain allowlist**: a new required setting, validated at startup (at least one
  domain, case-insensitive). The access-token signing key and the CSRF secret are new
  required secrets, refused in production when they hold a placeholder.
- **Admin user detail**: the open-order counts (draft, pending, approved with open lines)
  are added by the orders slice with real counts, an additive response field; this slice
  returns none (owner decision 2026-11-04, ADR-0019).
- **Order-level effects of role changes** (removing Buyer blocks order actions, removing
  Approver keeps earlier steps, dual-role self-approval) are tested in the slices that
  add those actions.
- **Organisation-wide audit log**: user audit events are written in this slice; the Admin
  screen that reads them arrives with the audit log (NFR-AUD-03).
- **Security log retention**: security events go to the structured log stream; keeping
  them 90 days is the log store's setting in a deployment, not the application's.
- **Demo users**: demo Buyers and one Approver get a documented local-only password, so a
  developer can log in; seeding is refused in production (slice 0).
- **Access request notifications**: in-app only, no email (ADR-0019).
- **Infrastructure**: no new services. Everything runs on the existing database, API,
  web, maintenance and Mailpit containers.

## Dependencies

- The binding decisions in ADR-0004, ADR-0006 (versioned updates), ADR-0007, ADR-0016,
  ADR-0017, ADR-0018 and ADR-0020, as amended on 2026-11-02.
- Slice 0: the users table, one-time tokens, the mail adapter, the error registry, the
  route access declaration, the audit trail, the purge service, the operator CLI and the
  web shell.
- Slices 2–7 depend on this slice's authentication, roles and access levels.
