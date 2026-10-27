# Configuration Contract — Slice 0

Every variable is documented in `.env.example`, which is the local setup and must start a
working stack unchanged. The repository is public, so `.env.example` holds **placeholder
values only**. Every secret starts with `change-me-`, and with `APP_ENV=production` any
value starting with `change-me-` is refused. CI replaces them with random throwaway values
(`scripts/ci-env.sh`). Each process validates only the variables it uses. A missing or
invalid one exits `1`, naming the key and the reason, never the value.

| Variable | Used by | Rule | `.env.example` value |
|---|---|---|---|
| `APP_ENV` | all | `local` \| `test` \| `production` | `local` |
| `COMPOSE_PROFILES` | compose | `local` starts Mailpit | `local` |
| `APP_ORIGIN` | api, migrate, cli | absolute URL, no trailing slash; used for the same-origin check and for links | `http://localhost:8080` |
| `WEB_PORT` | compose | host port of `web` | `8080` |
| `POSTGRES_PASSWORD` | db, migrate (db-init) | ≥ 16 characters | `change-me-postgres-local-only` |
| `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_MAINTENANCE_PASSWORD` | migrate (db-init) | ≥ 16 characters each, all different | `change-me-owner-local-only`, `change-me-app-local-only`, `change-me-maint-local-only` |
| `DATABASE_URL` | api, migrate (bootstrap), cli | `postgres://po_app:…@db:5432/po` | composed in compose from the above |
| `OWNER_DATABASE_URL` | migrate | `po_owner` connection | composed |
| `MAINTENANCE_DATABASE_URL` | maintenance only | `po_maintenance` connection | composed, given only to `maintenance` |
| `DB_POOL_SIZE`, `DB_TX_TIMEOUT_MS`, `DB_TX_MAX_WAIT_MS` | api | positive integers | `10`, `5000`, `2000` |
| `HTTP_PORT` | api | integer | `3000` |
| `METRICS_PORT` | api | integer, different from `HTTP_PORT`; exposed inside compose only | `9464` |
| `LOG_LEVEL` | all | `fatal` … `trace` | `info` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | api | host required, port integer, secure boolean, user and password optional, from an email address. With `APP_ENV=production`, host `mailpit` is refused, and sending requires TLS (implicit, or STARTTLS when `SMTP_SECURE=false`) | `mailpit`, `1025`, `false`, empty, empty, `no-reply@example.local` |
| `SEED_DEMO_DATA` | migrate | boolean; refused when `true` with `APP_ENV=production`. No seed exists in slice 0, but the flag and its rule do | `true` |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME` | migrate (bootstrap) | required **only** when no admin exists; email lower-cased; name 1–100 characters | `admin@example.local`, `Local Admin` |
| `PURGE_INTERVAL_HOURS` | maintenance | positive integer | `24` |

## Credential separation

Each process accepts only its own database credentials:

| Process | Must have | Refuses to start if present |
|---|---|---|
| `api`, `cli` | `DATABASE_URL` with user `po_app` | `OWNER_DATABASE_URL`, `POSTGRES_PASSWORD`, `MAINTENANCE_DATABASE_URL`, any `DB_*_PASSWORD`; or a `DATABASE_URL` whose user isn't `po_app` |
| `maintenance` | `MAINTENANCE_DATABASE_URL` with user `po_maintenance` | every other database variable (`DATABASE_URL`, `OWNER_DATABASE_URL`, `POSTGRES_PASSWORD`, any `DB_*_PASSWORD`); or a URL whose user isn't `po_maintenance` |
| `migrate` | `POSTGRES_PASSWORD`, `DB_*_PASSWORD`, `OWNER_DATABASE_URL`, `DATABASE_URL` (`po_app`, for the bootstrap) | `MAINTENANCE_DATABASE_URL` |

Compose gives each service only its own variables, through explicit `environment:` lists
and never a shared `env_file`. The config check is the backstop.

Rules checked by tests:
- With `APP_ENV=production`: `SEED_DEMO_DATA=true` → exit 1; `SMTP_HOST=mailpit` → exit 1;
  any secret starting with `change-me-` → exit 1.
- API and CLI, one test per forbidden variable: each present → exit 1, naming the variable.
  A `DATABASE_URL` whose user is `po_owner` or `postgres` → exit 1.
- Maintenance: each other database variable present → exit 1. A URL whose user isn't
  `po_maintenance` → exit 1.
- Migrate with `MAINTENANCE_DATABASE_URL` → exit 1.
- The compose file test: `api` and `maintenance` declare only their allowed variables.
- `METRICS_PORT` equal to `HTTP_PORT` → exit 1.
- An error message never contains the value of a key whose name includes `PASSWORD`,
  `SECRET`, `TOKEN`, `URL` or `KEY`. URLs embed credentials, and `*_KEY` covers the
  signing keys slice 1 adds.
