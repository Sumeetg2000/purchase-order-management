# Quickstart: Slice 1 — Accounts and user management

A run guide that proves the slice end to end. Results go to `quickstart-results.md` at
the end of the slice. Contracts: [api.md](contracts/api.md), [errors.md](contracts/errors.md),
[config.md](contracts/config.md), [cli.md](contracts/cli.md), [ui.md](contracts/ui.md).

## Prerequisites
- Docker with Compose v2, Node 24 (`.nvmrc`).
- `cp .env.example .env`; set `SIGNUP_ALLOWED_DOMAINS=example.com` and keep
  `SEED_DEMO_DATA=true` (local only).
- `docker compose up -d --build`; wait until `web` is healthy. App: `http://localhost:8080`
  (or `APP_ORIGIN`); test inbox: `http://localhost:8025`.

## 1. Bootstrap admin sets a password and logs in (US1)
1. `docker compose logs migrate | grep set-password` → one link
   (`…/reset-password#token=…`).
2. Before using it, log in as the admin → "No password is set for this account" (`401
   PASSWORD_NOT_SET`).
3. Open the link, set a 12+ character password → the address bar has no token; log in →
   Home.
4. Wrong password 4× → "Incorrect password."; 5th → "Too many failed attempts. Try again
   in 15 minutes."; right password → same lock message.

## 2. Silent refresh and logout (US1)
- Delete only `po_access` in the dev tools and click anything → login, with no refresh
  attempt (`401 UNAUTHENTICATED` never triggers one).
- The refresh path (`401 ACCESS_TOKEN_EXPIRED` → one refresh → retry) is shown by the
  Playwright spec `auth-refresh.spec.ts`, which plants an expired but correctly signed
  access token; or wait 15 minutes and click anything: no login prompt.
- Log out → `po_access`, `po_refresh` and `po_csrf` are gone; Back → login.

## 3. Signup → verify → access request → role (US2, US3)
1. Sign up `new.hire@example.com` → "Check your email". `@other.org` → "Use your company
   email address". Same email again → "An account with this email already exists".
2. Mailpit → verification email → open link → "Email verified" → log in → Access pending.
3. Send "Please give me Buyer access" → "Request sent on …".
4. As the admin: Users → badge 1 → Access requests → "Assign role" → Buyer → confirm.
5. The new hire's next action → login (session ended); log in → Buyer Home.

## 4. Admin actions (US3)
- Users filters `role=NONE`, `status=UNVERIFIED`, `q=new` → kept in the URL.
- Deactivate the demo Buyer → their open tab's next call → login with "This account has
  been deactivated"; login with the right password → same message.
- The admin's own row and other admin rows show no actions.

## 5. Profile, password, sessions (US4)
- Log in as a demo Buyer in two browsers. Profile → phone `98765 43210` → saved as
  `+919876543210`. Change password in browser A → browser B's next refresh → login.
- Sessions → revoke B; Log out everywhere → A goes to login too.

## 6. Forgot / reset (US5)
- Forgot password for an unknown email → "No account found with this email." For the
  demo Buyer → Mailpit → reset → all sessions end → log in with the new password.
- 4 forgot-password requests for one email within an hour → the 4th: "Too many attempts".

## 7. Operator CLI (US6)
```sh
docker compose exec api npm run admin -- admin:create --email second.admin@example.com --name "Second Admin"
docker compose exec api npm run admin -- admin:deactivate --email second.admin@example.com   # exit 0
docker compose exec api npm run admin -- admin:deactivate --email <bootstrap admin>          # ERROR LAST_ADMIN, exit 2
docker compose exec api npm run admin -- admin:reactivate --email second.admin@example.com   # exit 0
```

## 8. Automated checks
- `npm test` (backend accounts, sessions, authorization matrix, rate-limit, purge and
  query-plan suites; contracts inventory; frontend pages and dialogs), `npm run e2e`,
  contract drift, `npm run check:traceability`.
- `npm run perf:plans -w @po/backend` regenerates `docs/perf/plans/`; `git diff` shows
  only timing lines.
- Security log: `docker compose logs api | grep '"security":true'` shows each event with
  no token, password or phone.

## Demo accounts
`SEED_DEMO_DATA=true` creates `buyer1@example.com`, `buyer2@example.com` and
`approver@example.com`, password `DEMO_PASSWORD` from `backend/src/migrate/seed-demo.ts`
(local only; production refuses the seed).
