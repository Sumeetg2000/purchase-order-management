# Data model: Slice 1 — Accounts and user management

Four migrations, raw SQL like slice 0 (`backend/prisma/migrations/`), each with its
grants. `schema.prisma` mirrors every table and column, and the migrations test diffs
them. Values shared with code (statuses, reasons, lengths, retention days) are constants
in TypeScript, and a test pins each SQL copy to its constant.

## 0007_user_accounts: complete `users`

New columns:

| Column | Type | Rule |
|---|---|---|
| `phone` | `text NULL` | `CHECK (phone ~ '^\+[1-9][0-9]{6,14}$')` (E.164, normalised by the service) |
| `last_login_at` | `timestamptz NULL` | set on successful login |
| `failed_login_count` | `integer NOT NULL DEFAULT 0` | `CHECK (failed_login_count BETWEEN 0 AND 4)`: reaching 5 locks and resets to 0 |
| `locked_until` | `timestamptz NULL` | lockout end (ADR-0017) |

Unchanged from slice 0: `id`, `name` (1–100), `email` (lower-case, unique), `roles`
(the five sets, canonical order), `status`, `deactivated_at`, `password_hash`,
`version`, `created_at`, `updated_at`.

- **Version**: profile, role and status changes increment `version`. Login bookkeeping
  (`last_login_at`, `failed_login_count`, `locked_until`) and `password_hash` do not
  (ADR-0016).
- **Status transitions**: `UNVERIFIED → ACTIVE` (verification or completed reset),
  `ACTIVE ⇄ DEACTIVATED` (admin for Buyers and Approvers, operator CLI for Admins).
  `deactivated_at` follows the existing `CHECK`.
- **Indexes** (admin list, R13): `users_name_id_idx (name, id)`,
  `users_status_name_id_idx (status, name, id)`,
  `users_lower_name_prefix_idx (lower(name) text_pattern_ops)`,
  `users_lower_email_prefix_idx (lower(email) text_pattern_ops)`,
  `users_phone_purge_idx (deactivated_at) WHERE phone IS NOT NULL`.
- **Grants**: `po_app` keeps `SELECT, INSERT, UPDATE`. `po_maintenance` gets
  `SELECT (id, status, deactivated_at, phone)` and `UPDATE (phone)`.

## 0008_sessions: `sessions` and `refresh_tokens`

`sessions` (one row per login, i.e. per refresh family):

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid PK` | the JWT's `sid` |
| `user_id` | `uuid NOT NULL` → `users(id)` `ON DELETE RESTRICT` | |
| `created_at` | `timestamptz NOT NULL` | login time |
| `last_used_at` | `timestamptz NOT NULL` | login and each refresh |
| `absolute_expires_at` | `timestamptz NOT NULL` | `created_at + 30 days`; `CHECK (absolute_expires_at > created_at)` |
| `expires_at` | `timestamptz NOT NULL` | latest refresh token's expiry; `CHECK (expires_at <= absolute_expires_at)` |
| `user_agent` | `text NOT NULL` | truncated to 512 characters |
| `ip` | `inet NOT NULL` | |
| `revoked_at` | `timestamptz NULL` | |
| `revoke_reason` | `text NULL` | one of `SESSION_REVOKE_REASONS`; `CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))` |

`SESSION_REVOKE_REASONS`: `LOGOUT`, `LOGOUT_ALL`, `USER_REVOKED`, `REUSE_DETECTED`,
`PASSWORD_CHANGED`, `PASSWORD_RESET`, `ROLES_CHANGED`, `DEACTIVATED`.

- **Ended** = `revoked_at IS NOT NULL OR expires_at <= now` (R6).
- **Indexes**: `sessions_user_active_idx (user_id, last_used_at DESC, id DESC) WHERE
  revoked_at IS NULL` (list and revoke-all), `sessions_ended_idx
  ((coalesce(revoked_at, expires_at)))` (purge).

`refresh_tokens` (one row per issued refresh token, siblings included):

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid PK` | |
| `session_id` | `uuid NOT NULL` → `sessions(id)` `ON DELETE CASCADE` | |
| `token_hash` | `bytea NOT NULL UNIQUE` | SHA-256; `CHECK (octet_length(token_hash) = 32)` |
| `expires_at` | `timestamptz NOT NULL` | min(issue + 7 days, session absolute expiry) |
| `rotated_at` | `timestamptz NULL` | set once; never cleared |
| `created_at` | `timestamptz NOT NULL` | |

- **Grants**: `po_app`: `SELECT, INSERT` on both, `UPDATE (last_used_at, expires_at,
  revoked_at, revoke_reason)` on `sessions`, `UPDATE (rotated_at)` on `refresh_tokens`;
  no `DELETE`. `po_maintenance`: `SELECT, DELETE` on both.

## 0009_access_requests: `access_requests`

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid PK` | |
| `user_id` | `uuid NOT NULL` → `users(id)` | |
| `message` | `text NOT NULL` | `CHECK (char_length(message) BETWEEN 1 AND 500)` |
| `status` | `text NOT NULL` | `OPEN` \| `RESOLVED` \| `DISMISSED` |
| `admin_note` | `text NULL` | `CHECK (char_length(admin_note) <= 500)`; only when `DISMISSED` |
| `decided_by` | `uuid NULL` → `users(id)` | null for "Account deactivated" and while `OPEN` |
| `decided_at` | `timestamptz NULL` | `CHECK ((status = 'OPEN') = (decided_at IS NULL))` |
| `created_at`, `updated_at` | `timestamptz NOT NULL` | `updated_at` by the slice 0 trigger |

- **One open request per user**: `UNIQUE (user_id) WHERE status = 'OPEN'`.
- **Transitions**: `OPEN → RESOLVED` (a role assigned), `OPEN → DISMISSED` (admin dismiss
  or deactivation). Resolved and dismissed rows never change again; a new request is a
  new row.
- **Indexes**: `access_requests_status_updated_idx (status, updated_at DESC, id DESC)`,
  `access_requests_updated_idx (updated_at DESC, id DESC)`,
  `access_requests_user_latest_idx (user_id, created_at DESC)`.
- **Grants**: `po_app`: `SELECT, INSERT, UPDATE`. No `DELETE` for anyone but the owner.

## 0010_rate_limits: `rate_limit_counters`

| Column | Type | Rule |
|---|---|---|
| `bucket` | `text NOT NULL` | one of the bucket names in `rate-limit/buckets.ts` (`CHECK`) |
| `key` | `text NOT NULL` | IP, lower-cased email or user id |
| `window_start` | `timestamptz NOT NULL` | |
| `window_seconds` | `integer NOT NULL` | from the bucket; lets the purge find ended windows |
| `hits` | `integer NOT NULL` | `CHECK (hits >= 1)` |

- `PRIMARY KEY (bucket, key, window_start)`; index on
  `((window_start + make_interval(secs => window_seconds)))` for the purge.
- **Grants**: `po_app`: `SELECT, INSERT, UPDATE`. `po_maintenance`: `SELECT, DELETE`.

## Existing tables used

- `one_time_tokens` (slice 0): `VERIFY_EMAIL` (24 h) and `RESET` (30 min) tokens, single
  use, superseded on reissue. No schema change.
- `audit_entries` (slice 0): new actions added to `AuditEventCatalogue` (below). No schema
  change.

## Audit events written in this slice

All in the transaction of their change; `details` never contains a phone number.

| Action | Actor | `details` |
|---|---|---|
| `USER_SIGNED_UP` | the user, `SELF` | `emailDomain`, `roles: []` |
| `USER_EMAIL_VERIFIED` | the user, `SELF` | `via: 'link' \| 'reset'` |
| `USER_PROFILE_UPDATED` | the user, `SELF` | `name: { before, after }?`, `phone: 'set' \| 'changed' \| 'cleared'?` |
| `USER_ROLES_CHANGED` | admin, `ADMIN` | `before`, `after`, `sessionsRevoked` |
| `USER_DEACTIVATED` / `USER_REACTIVATED` | admin `ADMIN`, or `OPERATOR` | `before`, `after`, `sessionsRevoked` |
| `USER_PASSWORD_RESET_SENT` | admin, `ADMIN` | `targetUserId` |
| `ACCESS_REQUESTED` | the user, `SELF` | `requestId`, `message` |
| `ACCESS_REQUEST_RESOLVED` | admin, `ADMIN` | `requestId`, `roles` |
| `ACCESS_REQUEST_DISMISSED` | admin `ADMIN`, or the deactivating actor | `requestId`, `note` |
| `USER_PHONE_PURGED` | `SYSTEM` | `daysSinceDeactivation` |

The admin's identity is the entry's actor, so it is not repeated in `details`.
