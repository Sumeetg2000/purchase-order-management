# Operator CLI added in slice 1

`docker compose exec api npm run admin -- <command>` (slice 0 runner,
`backend/src/cli/admin.ts`). Each command runs in one transaction under `ADMIN_LOCK`,
audits as `OPERATOR` with `osUser` and `host`, prints `ERROR <code>: <message>` and exits with slice 0's `EXIT` codes.

| Command | Success | Refused (`EXIT.REFUSED`, 2) | No-op (`EXIT.OK`) |
|---|---|---|---|
| `admin:deactivate --email <e>` | `ACTIVE → DEACTIVATED`, all sessions revoked (`DEACTIVATED`), `USER_DEACTIVATED` audited | `USER_NOT_FOUND` (no account has the email), `NOT_AN_ADMIN` (an account that isn't `{ADMIN}`), `LAST_ADMIN` (would leave no `ACTIVE` admin) | already deactivated: message, nothing changes |
| `admin:reactivate --email <e>` | `DEACTIVATED → ACTIVE`, `deactivated_at` cleared, `USER_REACTIVATED` audited | `USER_NOT_FOUND`, `NOT_AN_ADMIN` | already active: message, nothing changes |

- Concurrency: `ADMIN_LOCK` serialises the count of active admins with the update, so
  two concurrent deactivations of the last two admins leave one active.
- An email no account has is `USER_NOT_FOUND` ("no account has that email; nothing was
  changed"), apart from `NOT_AN_ADMIN`, so the operator can tell a typo from a non-admin.
  The CLI runs on the server only, for operators with shell access: no enumeration concern.
  *Amended 2026-11-05 (owner decision):* this was `NOT_AN_ADMIN` too.
- Usage errors (missing `--email`) exit `EXIT.USAGE` (1), like `admin:create`.
