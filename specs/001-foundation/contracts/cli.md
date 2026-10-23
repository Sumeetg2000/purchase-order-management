# Operator CLI Contract — Slice 0

Run on the server only: `docker compose exec api npm run admin -- <command> [flags]`. No HTTP
route reaches it (a route-table test). Rules come from ADR-0016.

## Common behaviour

- Each command runs in **one transaction** under the advisory lock `ADMIN_LOCK`, which it
  shares with the bootstrap.
- The actor context is `OPERATOR`, with `osUser` (the OS user running the command) and
  `host` (the hostname), recorded in every audit entry's `details`.
- Output is human-readable lines on stdout. Errors go to stderr as
  `ERROR <CODE>: <message>`.

| Exit code | Meaning |
|---|---|
| `0` | success, or a no-op (a message says what was already true) |
| `1` | usage or validation error (`USAGE`, `INVALID_ARGUMENT`) |
| `2` | a rule refused the command (`EMAIL_IN_USE`, and later `LAST_ADMIN`, `NOT_AN_ADMIN`) |
| `3` | infrastructure failure (database unreachable or lock timeout) (`UNAVAILABLE`) |

## Commands in slice 0

### `admin:create --email <email> --name <name>`
- `--email`: required, a valid email, lower-cased before use. It may be outside
  `SIGNUP_ALLOWED_DOMAINS`.
- `--name`: required, 1–100 characters.
- On success it creates an `ACTIVE` user with role set `{ADMIN}` and no password, creates a
  `RESET` one-time token (30 minutes), and writes the audit entry `ADMIN_CREATED`
  (`details.source = "cli"`, plus `osUser` and `host`). It prints:
  ```
  Admin created: <email>
  One-time set-password link (valid 30 minutes, shown once):
  <APP_ORIGIN>/reset-password?token=<token>
  ```
- An email that already belongs to any user → `EMAIL_IN_USE`, exit 2, and nothing changes.
  A user is never promoted.

## Commands added by later slices

- Slice 1: `admin:deactivate`, `admin:reactivate`
- Slice 4: `policy:set`, `policy:show`

They follow the same rules.

## Bootstrap (not a CLI command, same rules)

The third step of the `migrate` service:
- If an `ADMIN` exists, it does nothing and prints nothing.
- If none exists, it creates the admin from the `BOOTSTRAP_ADMIN_*` variables, with actor
  `SYSTEM` and the audit entry `ADMIN_CREATED` (`details.source = "bootstrap"`), and prints
  the same link block once.
- If the variables are missing, or the email belongs to a non-admin user, it exits
  non-zero. `migrate` then fails, so `api` and `maintenance` never start.

The link points at the reset page that slice 1 builds. Until then it can't be used. Once it
expires, the admin uses forgot-password.
