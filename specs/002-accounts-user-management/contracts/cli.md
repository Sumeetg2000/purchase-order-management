# Operator CLI added in slice 1

`docker compose exec api npm run admin -- <command>` (slice 0 runner,
`backend/src/cli/admin.ts`). Each command runs in one transaction under `ADMIN_LOCK`,
audits as `OPERATOR` with `osUser` and `host`, prints `ERROR <code>: <message>` and exits with slice 0's `EXIT` codes.

| Command | Success | Refused (`EXIT.REFUSED`, 2) | No-op (`EXIT.OK`) |
|---|---|---|---|
| `admin:deactivate --email <e>` | `ACTIVE → DEACTIVATED`, all sessions revoked (`DEACTIVATED`), `USER_DEACTIVATED` audited | `NOT_AN_ADMIN` (no such admin, or not `{ADMIN}`), `LAST_ADMIN` (would leave no `ACTIVE` admin) | already deactivated: message, nothing changes |
| `admin:reactivate --email <e>` | `DEACTIVATED → ACTIVE`, `deactivated_at` cleared, `USER_REACTIVATED` audited | `NOT_AN_ADMIN` | already active: message, nothing changes |

- Concurrency: `ADMIN_LOCK` serialises the count of active admins with the update, so
  two concurrent deactivations of the last two admins leave one active.
- An unknown email is `NOT_AN_ADMIN` too: the operator learns the same thing (this email
  is not an admin), and the CLI has no enumeration concern.
- Usage errors (missing `--email`) exit `EXIT.USAGE` (1), like `admin:create`.
