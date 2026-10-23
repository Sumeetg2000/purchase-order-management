# ADR-0016: Users, user management and audit trail

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (profile phone, account status,
  assignable role sets, Admin user management: **signed off by the owner 2026-10-20**;
  operator CLI for admin accounts; signup with no role, access requests, retention)
- **Brief:** §2, §6 ("every action tied to a real, authenticated user"; "structured trace")
- **Principles:** III, IV, IX, X

## Context
Every action must be traceable to a real user, and the audit trail must be the record
procurement asks for in a dispute. That record has to stay correct even when users are
renamed, change roles or are deactivated later.

A deployment serves **one organisation**. There is no `org_id` and no multi-tenancy
(ADR-0019). Every user belongs to the one company.

The brief's Procurement Admin only *views*. Managing users through the API gives Admin a
new power, which changes an actor's permissions (Principle X), so it needed sign-off. The
owner approved it on 2026-10-20. Admin stays **read-only for orders**: user management is
a separate power and does not touch any order.

## Decision

### Users
- Fields:
  - `name`: 1–100 characters, editable by the user
  - `email`: stored lower-cased, unique, the login identifier. One per user, and nobody can
    change it, the user and admins included. There is no secondary email and no
    email-change flow.
  - `phone`: optional, normalised to E.164 (default region `IN`, libphonenumber). An invalid
    number → `400 VALIDATION_FAILED` with field code `INVALID_PHONE`.
  - `roles`: one of the **role sets** below
  - `status`: `UNVERIFIED` | `ACTIVE` | `DEACTIVATED`, plus `deactivatedAt` (set on each
    deactivation, cleared on reactivation)
  - `version`: for `If-Match` on admin updates (ADR-0006 semantics)
  - `lastLoginAt`; lockout bookkeeping (`failedLoginCount`, `lockedUntil`, ADR-0017)
  - Login bookkeeping updates don't increment `version`. Profile, role and status changes
    do.
- **Role sets** (a database `CHECK` enforces exactly these):
  - `{}` (no role): every new self-signup account. Not assignable through the API, so an
    Admin can't take every role away from a user. They deactivate the user instead.
  - `{BUYER}`, `{APPROVER}`, `{BUYER, APPROVER}`: the only sets that can be assigned
    through the API
  - `{ADMIN}`: created only by the bootstrap script or the operator CLI (below), never
    through the HTTP API. Admin is never combined with another role. The UI shows it as
    "Procurement Admin".
- **Status transitions**:
  - Signup creates an `UNVERIFIED` user with role set `{}`.
  - `UNVERIFIED → ACTIVE`: email verified, or a password reset completed. Both prove
    control of the mailbox (ADR-0017).
  - `ACTIVE → DEACTIVATED` and `DEACTIVATED → ACTIVE`: by an Admin for Buyers and
    Approvers, and by the operator CLI for Admins.
  - Users are **never deleted**.
- Only `ACTIVE` users can log in. `UNVERIFIED`, `DEACTIVATED` and locked-out users all get
  the same `401 INVALID_CREDENTIALS` (ADR-0017).
- Roles and status are **loaded on every request**. A deactivated user's next request →
  `401`. A request needing a role the user no longer has → `403`.
- **No role assigned** (`{}`): after verifying, the user can log in, view and edit `/me`,
  change their password, manage their sessions, log out and send an access request.
  Every other endpoint → `403 NO_ROLE_ASSIGNED` (ADR-0004). Assigning a first role is a
  normal role change: sessions are revoked, and the user logs in again into the role's
  screens.
- **Effect of role changes**:
  - **Removing BUYER**: the user's existing orders are unchanged, but they can no longer
    create, edit, submit, withdraw, delete or receive (`403`).
    - Their open orders follow the "reassignment not adopted" process (ADR-0004): an
      Approver rejects pending ones and cancels approved ones, and a new order is raised.
    - Their drafts remain and are harmless.
    - The admin confirm dialog shows the user's open-order counts before the change.
  - **Removing APPROVER**: takes effect on the next request. Steps they already approved
    stay valid.
  - **Dual role**: `SELF_APPROVAL` still applies (ADR-0004).
  - Every role change and every deactivation revokes all of the user's sessions
    (ADR-0017).

### Profile (every role)
- `GET /me` returns id, name, email, phone, roles, status and createdAt.
- `PATCH /me` accepts `{ name, phone }` only. The schema is strict, so email, roles,
  status or any other field → `400`. `phone: null` clears the phone.
  - Last write wins. There's no `If-Match`: only the user edits their own profile.
  - Audited as `USER_PROFILE_UPDATED`, with before/after.
- **Phone is personal data**: only the user and Admins see it. It never appears in audit
  entries (neither actor snapshots nor `details`), in anything an Approver or another Buyer
  can read, or in logs.
  - `USER_PROFILE_UPDATED` records only that the phone was set, changed or cleared, never
    the number.
  - **Purged 90 days after deactivation**: the daily purge (ADR-0020) clears `phone` on
    users with `status = DEACTIVATED` and `deactivatedAt` more than 90 days ago.
    - Name and email are kept, because the audit record needs them.
    - Reactivation doesn't restore the phone. The user can enter it again.
    - Audited as `USER_PHONE_PURGED`, actorType `SYSTEM`, with no phone value in
      `details`.

### Access requests
A no-role user can ask an administrator for access in the app. It's in-app only, with no
email: notifications stay deferred (ADR-0019).

| Endpoint | Behaviour |
|---|---|
| `POST /api/me/access-request { message }` | No-role users only (others → `403`). `message`: plain text, 1–500 characters. Creates an `OPEN` request, or updates the message of the user's open request. At most one `OPEN` request per user (partial unique index). After a request is resolved or dismissed, a new one can be opened. Rate limit: 3 per day per user → `429`. |
| `GET /api/me/access-request` | The user's latest request: status (`OPEN` / `RESOLVED` / `DISMISSED`), createdAt, updatedAt, decidedAt, and the admin note if any. `404` if the user has never sent one. |
| `GET /api/admin/access-requests` | Admin. Paginated (ADR-0007), filter `status`, sorted by `updatedAt` descending, then `id`. Each item includes the user's name, email and signup date. Index `(status, updated_at, id)`, with committed `EXPLAIN`. |
| `POST /api/admin/access-requests/:id/dismiss { note? }` | Admin. `note`: plain text, 0–500 characters, shown to the user. Only an `OPEN` request → otherwise `409 ACCESS_REQUEST_NOT_OPEN`. |

- **Resolution**: assigning a role to a user from the Users screen resolves their open
  request in the same transaction (`ACCESS_REQUEST_RESOLVED`).
- **Deactivation**: deactivating a user with an open request dismisses it in the same
  transaction, with the note "Account deactivated".
- The Users nav item shows an open-request count badge, read from the list's `total`
  with `status=OPEN&pageSize=1`.
- Messages and notes are stored and rendered **as text, never HTML**.

### Admin user management (signed off 2026-10-20)
| Endpoint | Behaviour |
|---|---|
| `GET /api/admin/users` | Paginated (ADR-0007). Filters: `role` (including `NONE` for no-role users), `status`, `q` (case-insensitive prefix of name or email). Sort: `name`, then `id`. Each item includes `lastLoginAt`. |
| `GET /api/admin/users/:id` | Profile, including phone, `lastLoginAt`, `version`, and open-order counts (draft, pending, approved with open lines) |
| `PATCH /api/admin/users/:id` | `{ roles, isActive }`, both optional. Requires `If-Match`: missing → `400 VERSION_REQUIRED`, stale → `409 VERSION_CONFLICT`. `roles` must be one of the three assignable sets; anything else → `400 VALIDATION_FAILED` (`INVALID_ROLE_SET`). Any other field → `400`. |
| `POST /api/admin/users/:id/reset-password` | Sends the standard reset email (ADR-0017). Returns `202`. |

- **Guards** (checked in this order, after `404`):
  1. Target is the caller → `409 SELF_MODIFICATION`. An admin can't deactivate or change
     themself.
  2. Target holds `ADMIN` → `409 ADMIN_NOT_MODIFIABLE`.
  3. `isActive: true` on an `UNVERIFIED` user → `409 USER_UNVERIFIED`. Admins can't verify
     an email on someone's behalf. They can send a reset email instead, and completing it
     verifies the account.
- **Admins never set or see passwords.**
- A no-op change (same roles, same status) writes nothing: no audit entry and no
  revocation.
- Roles and status changed in one request → one transaction, one audit entry per change.
- **Indexes**: `(name, id)`, `(status, name, id)`, `lower(name) text_pattern_ops` and
  `lower(email) text_pattern_ops` for the prefix search. `role` is a low-selectivity
  predicate applied on top. The page query and its `COUNT` have committed
  `EXPLAIN (ANALYZE, BUFFERS)` output at a seeded 10,000-user dataset, so the
  index paths are exercised.

### Bootstrap admin
- On startup, if no `ADMIN` exists, a script creates one from `BOOTSTRAP_ADMIN_EMAIL` and
  `BOOTSTRAP_ADMIN_NAME`, with status `ACTIVE` and no password. It prints a one-time
  set-password link (a `RESET` token, ADR-0017) to the log.
- It runs under an advisory lock, so two instances can't both create an admin. It is
  idempotent: once an admin exists it does nothing and never prints a token again.
- It's audited as `ADMIN_CREATED` with actorType `SYSTEM` and `details.source =
  "bootstrap"`.
- If the link expires, the admin uses forgot-password.
- This and the operator CLI's `admin:create` link (below) are the **only two exceptions**
  to "no tokens in logs" (Principle IX). Each is printed once, and the token is single-use
  and expires in 30 minutes.
- If no admin exists and the variables are unset, or the email belongs to an existing
  non-admin user, startup fails with a clear error. An existing user is never promoted.
- Bootstrap runs on first start only. After that, admins are managed with the operator CLI.
- The demo seed (only with `SEED_DEMO_DATA=true`, never in production; ADR-0020) creates
  Buyers and one Approver, never an admin.

### Operator CLI for admin accounts
Admin accounts are managed by an operator with shell access to the server, never over HTTP:
`docker compose exec api npm run admin -- <command>`. Within the API, Admins still can't
modify Admin accounts (`409 ADMIN_NOT_MODIFIABLE`). A deployment can have several admins.

| Command | Behaviour |
|---|---|
| `admin:create --email --name` | Creates an `ACTIVE` `{ADMIN}` user with no password and prints a one-time set-password link (a `RESET` token), like bootstrap. The email may be outside `SIGNUP_ALLOWED_DOMAINS`. An email that belongs to an existing user → error `EMAIL_IN_USE`; a non-admin is never promoted. |
| `admin:deactivate --email` | Deactivates an admin and revokes all their sessions. It refuses to deactivate the last `ACTIVE` admin → error `LAST_ADMIN`. A non-admin email → error `NOT_AN_ADMIN`. |
| `admin:reactivate --email` | Reactivates a deactivated admin. A non-admin email → error `NOT_AN_ADMIN`. |
| `policy:set --tier1 <amount>`, `policy:show` | Approval policy changes and display (ADR-0002) |

- Each command runs in one transaction under the same advisory lock as bootstrap. Two
  concurrent `admin:deactivate` runs therefore can't leave zero active admins.
- Errors print the code and exit non-zero. A no-op (for example reactivating an active
  admin) prints a message, changes nothing and exits zero.
- **Audited** with `actorType` `OPERATOR` and no `actorUserId`. `details` records the OS
  user and host running the command, read by the CLI from the process environment.
  Events: `ADMIN_CREATED`, `USER_DEACTIVATED`, `USER_REACTIVATED` and
  `APPROVAL_POLICY_CHANGED`.
- The printed set-password link goes to the operator's terminal only. If it expires, the
  admin uses forgot-password.

### Audit entry fields
`occurredAt` (DB clock, UTC) · `actorType` (`USER` | `SYSTEM` | `OPERATOR`) ·
`actorUserId` · actor **snapshot** `{ name, email }` · `actingRole` · `action` · entity
`{ type, id }` · `orderId` and PO number (order events) · structured `details` ·
`requestId`.

The snapshot makes past entries immutable even after a rename, and it never includes the
phone. `actingRole` records the capacity the user acted in (for example APPROVER when a
dual-role user approves, ADMIN for user management). Self-service events (signup,
verification) have the user as their own actor.

A database `CHECK` ties the actor fields to `actorType`:
- `USER`: requires `actorUserId`, the snapshot and `actingRole`
- `SYSTEM`: none of them
- `OPERATOR`: no `actorUserId`, and `details` must contain `osUser` and `host`

### Event catalogue (before/after in `details`)
| Action | Details |
|---|---|
| `PO_CREATED` | vendor, lines, total |
| `PO_EDITED` | header/vendor before → after; lines added, removed, and changed with field-level before/after |
| `PO_SUBMITTED` | total, tiers in chain, policy version, resulting status |
| `PO_AUTO_APPROVED` | actorType `SYSTEM`, threshold, policy version |
| `APPROVAL_STEP_APPROVED` | tier, step, version approved |
| `APPROVAL_STEP_REJECTED` | tier, step, reason |
| `PO_WITHDRAWN` | reason, voided steps |
| `PO_DRAFT_DELETED` | PO number, full contents |
| `PO_CANCELLED` | reason, per line ordered and received |
| `GOODS_RECEIPT_RECORDED` | line, quantity, `receivedBefore`, `receivedAfter`, `outstandingAfter` |
| `VENDOR_CREATED` / `VENDOR_UPDATED` / `VENDOR_DEACTIVATED` / `VENDOR_REACTIVATED` | before → after |
| `APPROVAL_POLICY_CHANGED` | actorType `OPERATOR`; policy version and tiers before → after; `osUser`, `host` |
| `USER_SIGNED_UP` | user id, email domain, initial role set |
| `USER_EMAIL_VERIFIED` | how: verification link or completed reset |
| `USER_PROFILE_UPDATED` | name before → after; phone only as `set` / `changed` / `cleared`, never the number |
| `USER_PHONE_PURGED` | actorType `SYSTEM`; user id; days since deactivation; never the number |
| `USER_ROLES_CHANGED` | roles before → after; sessions revoked |
| `USER_DEACTIVATED` / `USER_REACTIVATED` | status before → after; sessions revoked. By an Admin (`USER`) or the operator CLI (`OPERATOR`, with `osUser` and `host`) |
| `USER_PASSWORD_RESET_SENT` | target user (admin-initiated resets only) |
| `ACCESS_REQUESTED` | request id; message (first send and each update) |
| `ACCESS_REQUEST_RESOLVED` | request id; roles assigned; resolving admin |
| `ACCESS_REQUEST_DISMISSED` | request id; note; dismissing admin, or "Account deactivated" |
| `ADMIN_CREATED` | new admin's id, name and email; `details.source`: `cli` (actorType `OPERATOR`, with `osUser` and `host`) or `bootstrap` (actorType `SYSTEM`) |

Authentication events (logins, lockouts, password changes, session revocations) are
**security logs**, not business audit (ADR-0017).

### Integrity
- Written in the same transaction as the change. Triggers require the transaction-local
  actor context.
- Append-only: the app role has `INSERT`/`SELECT` only. There is no foreign key to orders,
  so entries survive draft deletion.

### Retention
- Audit entries are kept for **8 years**, the period the Companies Act 2013 s.128(5)
  requires for books of account and supporting records.
- Any purge of older entries runs under the separate maintenance database role, never the
  app role (ADR-0020).
- Under the DPDP Act 2023, audit actor snapshots (name and email) are kept for that period
  on the **legal-obligation** basis: they are part of the statutory record. Phones are never
  in snapshots.
- Session and security-log data has its own 90-day rule (ADR-0017, ADR-0020).

### Visibility (paginated, read-only, filtered in SQL)
- **Admin**: any order's timeline, plus an organisation-wide log filterable by actor,
  action, entity type, PO number, vendor and date range. User events appear only here.
  Indexes match each filter and the `(occurredAt, id)` sort.
- **Buyer**: timelines of their own orders, and vendor history.
- **Approver**: timelines of orders they can read (Principle III). No vendor history and no
  organisation-wide log.

## Alternatives
- **Self-signup grants BUYER** (the earlier draft): any employee could raise orders up to
  ₹1,00,000 that auto-approve, with nobody choosing to give them that power. Replaced by
  the no-role account plus an access request.
- **Users managed only by seed or ops scripts** (the earlier decision): no extra Admin
  power, but every hire, leaver and role change needs an operator. Replaced, with sign-off.
- **Admin can assign ADMIN**: one compromised admin could create more. Rejected. Admins
  come only from bootstrap or the operator CLI, which require shell access to the server.
- **Exactly one admin, replaced by an operator-run migration** (the earlier draft): no
  way to add a second admin or recover from a departed one without hand-written SQL.
  Replaced by the operator CLI.
- **Admin management over HTTP** (a super-admin role): a new, more powerful role that has
  to be protected over the network. Rejected.
- **Editable email** (with re-verification): adds a flow, and makes the actor snapshot and
  login identity harder to follow. Not adopted.
- **Hard delete of users**: breaks audit actor references. Rejected.

## Tests
- Profile:
  - `GET /me` returns the listed fields.
  - `PATCH /me` changes name and phone. Phone is normalised to E.164 and `null` clears it.
    An invalid phone → 400.
  - `PATCH /me` with email, roles or status → 400.
  - The phone is absent from audit actor snapshots and from every response an Approver can
    read.
- Roles and status:
  - roles outside the three sets → 400, including `{}` through the admin API
  - a new signup has role set `{}`; the role-set `CHECK` accepts `{}` and rejects other
    unlisted sets
  - removing BUYER blocks create, edit, submit, withdraw and receive (403) and leaves the
    user's orders unchanged
  - removing APPROVER → the next approve is 403, and earlier approved steps stay valid
  - a role change revokes sessions and enforces the new role
  - deactivation → next request 401 and login 401
  - a dual-role user can't self-approve
  - the role-set `CHECK` rejects raw-SQL `{ADMIN, BUYER}`
- Admin endpoints:
  - `ADMIN_NOT_MODIFIABLE`, `SELF_MODIFICATION` and `USER_UNVERIFIED`
  - missing or stale `If-Match`
  - a no-op PATCH writes nothing
  - the reset email is sent
  - list filters (role, status, `q` prefix on name and email, case-insensitive),
    pagination, sort stability, and committed `EXPLAIN` for the page and its `COUNT`
- Bootstrap: creates exactly one admin and prints the link once. A second start prints
  nothing. Two concurrent starts create one admin. An existing non-admin email → startup
  fails.
- Operator CLI:
  - `admin:create` makes a second admin and prints a link
  - an existing non-admin email → `EMAIL_IN_USE`, and nothing changes
  - `admin:deactivate` deactivates one of two admins and revokes their sessions
  - deactivating the last active admin → `LAST_ADMIN`, and nothing changes
  - two concurrent deactivations of the last two admins leave one active
  - `admin:reactivate` works; a non-admin email → `NOT_AN_ADMIN`
  - each change is audited with `actorType` `OPERATOR`, `osUser` and `host`
  - the audit `CHECK` rejects an `OPERATOR` entry without `osUser` or `host`, and a `USER`
    entry without `actorUserId`
  - no HTTP route reaches these commands (route-table check)
- No-role users: `/me`, password, sessions, logout and the access request work; every
  other endpoint → `403 NO_ROLE_ASSIGNED`.
- Access requests:
  - the first send creates `OPEN`; a second send updates the message, with one row
  - a fourth send in a day → 429
  - a user with a role → 403
  - `GET` shows the status and dates, or 404 if none was ever sent
  - admin list filter, pagination and `EXPLAIN`
  - assigning a role resolves the open request in the same transaction
  - dismiss with a note, shown to the user; dismissing a non-open request → 409
    `ACCESS_REQUEST_NOT_OPEN`
  - deactivation dismisses the open request
  - a new request after a dismissal works
  - message HTML is returned verbatim as text and rendered escaped (frontend test)
  - each step is audited
- Retention purge: runs only as the maintenance role (the app role's `DELETE` on audit is
  denied) and removes only entries older than 8 years.
- Phone purge:
  - a user deactivated 91 days ago has the phone cleared; one deactivated 89 days ago, or
    an active user, keeps it (injected clock)
  - name and email unchanged
  - `USER_PHONE_PURGED` written with actorType `SYSTEM` and no number
  - reactivation leaves the phone empty
  - the maintenance role can update only the `phone` column of users
- `USER_PROFILE_UPDATED` never contains a phone number.
- Every event's payload. Dual-role `actingRole`. `SYSTEM` on auto-approval.
- Renaming a user doesn't change old entries' actor snapshot.
- Audit visibility per role: a Buyer viewing another buyer's timeline → 404; an Approver
  viewing the organisation-wide log → 403.
- Organisation-wide log filters and pagination, with committed `EXPLAIN`.
- UPDATE/DELETE on audit as app role → denied. A rollback leaves no entry.
- Every new endpoint × role cell of the authorization matrix (Principle III).
