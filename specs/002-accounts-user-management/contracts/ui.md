# Web app contract: Slice 1

Screens and dialogs from ADR-0018 for this slice. Every page has loading, empty and
error states, axe checks, and lazy loading (one chunk each, ≤ 150 KB gzip).

## Routes

| Path | Who | Page |
|---|---|---|
| `/login?returnTo=` | anonymous | Login: each login code's message; `ACCOUNT_NOT_VERIFIED` offers resend, `PASSWORD_NOT_SET` links forgot-password, `ACCOUNT_LOCKED` shows N minutes |
| `/signup` | anonymous | Signup: password policy shown; field codes from the API; success → "Check your email" |
| `/verify-email#token=` | anyone | Verify: posts once, clears the hash; success → login link; each token code's message (`TOKEN_EXPIRED` offers resend) |
| `/forgot-password` | anyone | Forgot: specific outcome per code |
| `/reset-password#token=` | anyone | Reset / set password: posts once with the new password, clears the hash; each token code's message (`TOKEN_EXPIRED` links forgot-password) |
| `/access-pending` | no-role user | Access pending: signup date, message form (1–500), request status, admin note as text |
| `/profile` | any logged-in user | Profile (name), Change password, Sessions (revoke one, log out everywhere) |
| `/admin/users?role=&status=&q=&page=` | Admin | Users list, filters in the URL; row actions |
| `/admin/users/access-requests?status=&page=` | Admin | Access requests tab |
| `/` | logged-in user with a role | Home for the role (placeholder until later slices) |

Guards: no user → `/login?returnTo=…`; no role → `/access-pending`; wrong role → 403
page. They only hide; the API enforces.

## Auth flow (R17)
`frontend/src/auth/`: `AuthProvider` (current user from `GET /api/me`),
`refreshSession()` (single-flight within the tab), the openapi-fetch
middleware (CSRF header, `401`/`403` routing; the login page shows the logged-out
logged-out message for `SESSION_REVOKED`, with or without a `reason`), `RequireUser`, `RequireRole`,
`useFragmentToken()`.

## Dialogs (ADR-0018 wording)
Change role (old → new, sessions end, resolves the access request,
only-Approver warning), Deactivate user, Reactivate user, Send password reset (not offered for a deactivated user), Dismiss
access request (optional note), Log out everywhere, Revoke a session (current one says it
logs you out), Change password. Open-order counts join the change-role and deactivate
dialogs with orders (ADR-0019, 2026-11-04). No dialog on profile save. The unsaved-changes guard
covers the profile form.

## Nav
Admins see an open access-request badge on Users, from `GET /api/admin/access-requests
?status=OPEN&pageSize=1` `total`, refreshed every 60 s, on focus and after each related
action.
