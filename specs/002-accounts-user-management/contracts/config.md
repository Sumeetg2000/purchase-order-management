# Configuration added in slice 1

API process only (`backend/src/config/api.ts`); validated at startup, and invalid config
exits non-zero. `.env.example` gets placeholders, `scripts/ci-env.sh` random throwaway
values, `scripts/dev-env.mjs` the dev defaults.

| Variable | Rule | Production refusal |
|---|---|---|
| `SIGNUP_ALLOWED_DOMAINS` | comma-separated, trimmed, lower-cased, each a valid domain, at least one | — |
| `JWT_SIGNING_KEY` | base64url, decodes to ≥ 32 bytes | the `.env.example` placeholder |
| `JWT_KEY_ID` | 1–64 characters `[A-Za-z0-9._-]` | — |
| `CSRF_SECRET` | base64url, decodes to ≥ 32 bytes, different from `JWT_SIGNING_KEY` | the `.env.example` placeholder |

- The two secrets are added to the logger's redaction list and never printed by the
  config error report (only the variable name and the rule).
- No setting for the rate-limit store (ADR-0017, amended 2026-11-02): counters are always
  in PostgreSQL.
- Lifetimes, limits and retention periods are named constants, not settings (ADR-0017's
  numbers are decisions, not deployment choices).
