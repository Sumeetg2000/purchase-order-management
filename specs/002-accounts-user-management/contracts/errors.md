# Error codes added in slice 1

Added to `ERROR_REGISTRY` (`packages/contracts/src/errors.ts`) and to the web app's
`Record<ErrorCode, ErrorMessage>` map in the same commit. Statuses and wording are
ADR-0007's and ADR-0017's (amended 2026-11-02).

| Code | Status | Web message (next step) |
|---|---|---|
| `UNAUTHENTICATED` | 401 | "Please log in." → login |
| `ACCESS_TOKEN_EXPIRED` | 401 | never shown: triggers one refresh |
| `SESSION_EXPIRED` | 401 | "Your session has expired. Please log in again." → login with `returnTo` |
| `SESSION_REVOKED` | 401 | same as `SESSION_EXPIRED` |
| `PASSWORD_NOT_SET` | 401 | "No password is set for this account. Use your set-password link, or reset your password." → forgot-password |
| `INCORRECT_PASSWORD` | 401 | "Incorrect password." |
| `ACCOUNT_NOT_VERIFIED` | 401 | "Verify your email before logging in." → resend |
| `ACCOUNT_DEACTIVATED` | 401 | "This account has been deactivated. Contact an admin." |
| `SIGNUP_DOMAIN_NOT_ALLOWED` | 400 | "Use your company email address to sign up." |
| `INVALID_TOKEN` | 400 | "This link is invalid or has expired." → resend or forgot-password |
| `FORBIDDEN` | 403 | "You don't have permission to do this." |
| `NO_ROLE_ASSIGNED` | 403 | never shown: routes to Access pending |
| `ACCOUNT_NOT_FOUND` | 404 | "No account found with this email." → signup |
| `EMAIL_IN_USE` | 409 | "An account with this email already exists." → login, forgot-password |
| `ACCOUNT_ALREADY_VERIFIED` | 409 | "This account is already verified." → login |
| `VERSION_CONFLICT` | 409 | "Someone else changed this. Reload to see the latest version." → reload |
| `SELF_MODIFICATION` | 409 | "You can't change your own account here." |
| `ADMIN_NOT_MODIFIABLE` | 409 | "Admin accounts are managed by the operator." |
| `USER_UNVERIFIED` | 409 | "This user hasn't verified their email. Send them a password reset instead." |
| `ACCESS_REQUEST_NOT_OPEN` | 409 | "This request has already been handled." → reload |
| `ACCOUNT_LOCKED` | 423 | "Too many failed attempts. Try again in N minutes." (N from `Retry-After`) |
| `RATE_LIMITED` | 429 | "Too many attempts. Try again in N minutes." |

Field codes added to `FIELD_CODES` (inside `400 VALIDATION_FAILED`): `VERSION_REQUIRED`,
`INVALID_PHONE`, `INVALID_ROLE_SET`, `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`,
`PASSWORD_TOO_COMMON`, `INCORRECT_PASSWORD`.

Operator CLI codes added to `backend/src/lib/operator-codes.ts`: `LAST_ADMIN`,
`NOT_AN_ADMIN`.
