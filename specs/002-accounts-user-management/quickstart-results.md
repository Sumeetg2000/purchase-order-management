# Quickstart results: Slice 1 — Accounts and user management

Run 2026-11-05 against a clean stack: a copy of `.env.example` with
`SIGNUP_ALLOWED_DOMAINS=example.com`, `docker compose up -d --build --wait` as an isolated
compose project (`po-qs`, ports 28080 and 28025, removed with its volumes afterwards), so
the default stack was never touched. Steps 1 and 3–7 were driven over HTTP through `web`
(`/api`), Mailpit's API and `docker compose exec api`. The browser-only parts are covered by
the Playwright specs named below, which ran green on the same day (28 passed).

**Result: 60 checks, 0 failed.** `api`, `db`, `mailpit` and `web` healthy; `maintenance`
running.

| Step | Checked | Result |
|---|---|---|
| 1. Bootstrap admin | one set-password link in the `migrate` log; login before setting it → `401 PASSWORD_NOT_SET`; set from the link → 204; login → 200 | Pass |
| 1.4 Lockout | 4 wrong passwords → `401 INCORRECT_PASSWORD`; 5th → `423 ACCOUNT_LOCKED`; right password while locked → `423 ACCOUNT_LOCKED` | Pass |
| 2. Refresh and logout | no access cookie → `401 UNAUTHENTICATED`; logout → 204, `po_access`, `po_refresh` and `po_csrf` cleared; old access token → `401 SESSION_REVOKED`. Silent refresh and the no-refresh-on-`UNAUTHENTICATED` path: `auth-refresh.spec.ts`; Back → login: `logout.spec.ts` | Pass |
| 3. Signup → Buyer | signup → 202; `@other.org` → `400 SIGNUP_DOMAIN_NOT_ALLOWED`; same email → `409 EMAIL_IN_USE`; verify from the Mailpit link with the signup password → 204; login → no role; access request → 200; admin route → `403 NO_ROLE_ASSIGNED`; one open request; assign Buyer → 200; the hire's next call → `401 SESSION_REVOKED`; login → Buyer; request resolved. Screens: `signup-to-buyer.spec.ts` | Pass |
| 4. Admin actions | filters `role=NONE`, `status=UNVERIFIED`, `q=new` → 200; deactivate buyer2 → their next call and their login → `401 ACCOUNT_DEACTIVATED`; the admin's own row → `409 SELF_MODIFICATION` (the own-row guard comes before the admin guard, contracts/api.md). Read-only rows and URL filters: `admin-users.spec.ts` | Pass |
| 5. Profile, password, sessions | rename → 200; change password in A → B's refresh `401 SESSION_REVOKED`, A kept; revoke another session → its next call `401 SESSION_REVOKED`; logout-all → 204, then `401 UNAUTHENTICATED` (cookies cleared). Screens: `profile-sessions.spec.ts` | Pass |
| 6. Forgot / reset | unknown email → `404 ACCOUNT_NOT_FOUND`; reset from the Mailpit link → 204, existing sessions `401 SESSION_REVOKED`, new password logs in; 4th forgot-password for one email → `429 RATE_LIMITED`. Screens: `forgot-reset.spec.ts` | Pass |
| 7. Operator CLI | `admin:create` prints a link (exit 0); `admin:deactivate` second admin (exit 0); last admin → `LAST_ADMIN` (exit 2); `admin:reactivate` (exit 0) | Pass |
| 8. Automated checks | `npm test`: backend 697, contracts 57, frontend 223, scripts 90, all passed; `npm run e2e:local`: 28 passed; `npm run check:traceability`: ok; bundle budget ok (largest route chunk 23.2 KB of 150 KB) | Pass |
| 8. Security log | 33 `"security":true` lines; no password, token or password hash in any | Pass |

Notes:
- Quickstart step 4 says the admin's own row "shows no actions"; over the API the guard
  answers `409 SELF_MODIFICATION`, as the contract orders it.
- The default `.env.example` allows `example.local` for signup; the quickstart's
  `example.com` override is still needed for its `new.hire@example.com` example.
