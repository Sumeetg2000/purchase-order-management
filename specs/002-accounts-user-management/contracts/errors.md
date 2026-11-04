# Error codes added in slice 1

Added to `ERROR_REGISTRY` (`packages/contracts/src/errors.ts`) and to the web app's
`Record<ErrorCode, ErrorMessage>` map in the same commit. Statuses and wording are
ADR-0007's and ADR-0017's (amended 2026-11-02 and 2026-11-03).

| Code | Status | Web message (next step) |
|---|---|---|
| `UNAUTHENTICATED` | 401 | "Please log in." → login |
| `ACCESS_TOKEN_EXPIRED` | 401 | never shown: triggers one refresh |
| `SESSION_EXPIRED` | 401 | "Your session has expired. Please log in again." → login with `returnTo` |
| `SESSION_REVOKED` | 401 | with `reason`: "You were logged out because <reason>. Please log in again."; without: "You've been logged out. Please log in again." → login with `returnTo` |
| `PASSWORD_NOT_SET` | 401 | "No password is set for this account. Use your set-password link, or reset your password." → forgot-password |
| `INCORRECT_PASSWORD` | 401 | "Incorrect password." |
| `ACCOUNT_NOT_VERIFIED` | 401 | "Verify your email before logging in." → resend |
| `ACCOUNT_DEACTIVATED` | 401 | "This account has been deactivated. Contact an admin." |
| `SIGNUP_DOMAIN_NOT_ALLOWED` | 400 | "Use your company email address to sign up." |
| `TOKEN_EXPIRED` | 400 | "This link has expired. Request a new one." → resend or forgot-password |
| `TOKEN_USED` | 400 | "This link has already been used." → login |
| `TOKEN_SUPERSEDED` | 400 | "A newer link was sent. Use the latest email." |
| `INVALID_TOKEN` | 400 | "This link isn't valid. Check that you opened the whole link from the email." → resend or forgot-password |
| `FORBIDDEN` | 403 | "You don't have permission to do this." |
| `NO_ROLE_ASSIGNED` | 403 | never shown: routes to Access pending |
| `ACCOUNT_NOT_FOUND` | 404 | "No account found with this email." → signup |
| `EMAIL_IN_USE` | 409 | "An account with this email already exists." → login, forgot-password |
| `ACCOUNT_ALREADY_VERIFIED` | 409 | "This account is already verified." → login |
| `VERSION_CONFLICT` | 409 | "Someone else changed this. Reload to see the latest version." → reload |
| `SELF_MODIFICATION` | 409 | "You can't change your own account here." |
| `ADMIN_NOT_MODIFIABLE` | 409 | "Admin accounts are managed by the operator." |
| `USER_UNVERIFIED` | 409 | "This user hasn't verified their email. Send them a password reset instead." |
| `USER_DEACTIVATED` | 409 | "This user is deactivated." → reactivate them first. A deactivated account gets no reset email (added 2026-11-04) |
| `ACCESS_REQUEST_NOT_OPEN` | 409 | "This request has already been handled." → reload |
| `ACCOUNT_LOCKED` | 423 | "Too many failed attempts. Try again in N minutes." (N from `Retry-After`) |
| `RATE_LIMITED` | 429 | "Too many attempts. Try again in N minutes." |

Token codes are checked in the order used → superseded → expired; no row with that hash
and purpose (a typo, the wrong page, or a token already purged) is `INVALID_TOKEN`.

`SESSION_REVOKED` may carry `reason`, an optional RFC 9457 extension member of `Problem`
typed by the public enum `PUBLIC_REVOKE_REASONS` in `packages/contracts`
(`PublicRevokeReason`). It is set only on this code, only for the session whose refresh
cookie made the request, and only for a public reason:

| `reason` | `<reason>` in the message |
|---|---|
| `PASSWORD_CHANGED` | "your password was changed" |
| `PASSWORD_RESET` | "your password was reset" |
| `ROLES_CHANGED` | "your roles were changed" |

The sessions table and the security log keep all eight `SESSION_REVOKE_REASONS` (backend
only, built from the public three plus `DEACTIVATED`, `LOGOUT`, `LOGOUT_ALL`,
`USER_REVOKED`, `REUSE_DETECTED`). The other five never leave the API: `LOGOUT`,
`LOGOUT_ALL`, `USER_REVOKED` and `REUSE_DETECTED` send no `reason` and the web app shows
"You've been logged out. Please log in again."; `DEACTIVATED` never shows, because a
deactivated user gets `ACCOUNT_DEACTIVATED` first. `reason` is a new optional member rather than a new shape of
`details`: oasdiff counts changing `details` from an array to a union as breaking
(probed 2026-11-03), and an added optional member as additive.

Field codes added to `FIELD_CODES` (inside `400 VALIDATION_FAILED`): `VERSION_REQUIRED`,
`INVALID_ROLE_SET`, `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`,
`PASSWORD_TOO_COMMON`, `INCORRECT_PASSWORD`, `PASSWORD_UNCHANGED`.

`PASSWORD_UNCHANGED` ("Your new password must be different from your current one.") is
change-password's, on `body.newPassword`: checked after the current password is
verified, by comparing the two inputs, and nothing is written.

Operator CLI codes added to `backend/src/lib/operator-codes.ts`: `LAST_ADMIN`,
`NOT_AN_ADMIN`.
