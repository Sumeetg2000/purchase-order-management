# API contract: Slice 1

The source of truth stays `packages/contracts` (ADR-0008): `OPERATIONS` plus the Zod
schemas below; `openapi.json` is generated from them. This file is the reviewed design,
written before any service code. Every path is under `/api`.

## Shared schemas (`packages/contracts/src/schemas/`)

```ts
// pagination.ts (ADR-0007)
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 50;
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
};
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), page: z.int(), pageSize: z.int(), total: z.int() });

// ids.ts
export const idParams = z.strictObject({ id: z.uuid() }); // non-UUID → 400 (ADR-0007)

// users.ts (constants already there; additions)
export const USER_NAME_MAX = 100;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const ASSIGNABLE_ROLE_SETS = [[BUYER], [APPROVER], [BUYER, APPROVER]] as const;
export const userName = z.string().trim().min(1).max(USER_NAME_MAX);
export const passwordSchema = /* R4: custom issues PASSWORD_TOO_SHORT / _TOO_LONG */;
export const phoneInput = z.string().max(32).nullable(); // normalised by the service (R11)
export const roleSet = z.array(z.enum(USER_ROLES)); // service checks it is assignable
```

```ts
// auth.ts
export const loginBody = z.strictObject({ email: emailAddressSchema, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
export const signupBody = z.strictObject({ name: userName, email: emailAddressSchema, password: passwordSchema });
export const tokenBody = z.strictObject({ token: z.string().min(1).max(128) });
export const emailBody = z.strictObject({ email: emailAddressSchema });
export const resetPasswordBody = z.strictObject({ token: z.string().min(1).max(128), newPassword: passwordSchema });
export const changePasswordBody = z.strictObject({ currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH), newPassword: passwordSchema });

// me.ts
export const me = z.strictObject({
  id: z.uuid(), name: z.string(), email: z.string(), phone: z.string().nullable(),
  roles: z.array(z.enum(USER_ROLES)), status: z.enum(USER_STATUSES), createdAt: z.iso.datetime(),
});
export const updateMeBody = z.strictObject({ name: userName.optional(), phone: phoneInput.optional() })
  .refine((b) => b.name !== undefined || b.phone !== undefined); // empty body → 400 REQUIRED

// sessions.ts
export const sessionItem = z.strictObject({
  id: z.uuid(), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime(),
  userAgent: z.string(), ip: z.string(), current: z.boolean(),
});

// access-requests.ts
export const ACCESS_REQUEST_STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export const ACCESS_REQUEST_TEXT_MAX = 500;
export const accessRequestBody = z.strictObject({ message: z.string().trim().min(1).max(ACCESS_REQUEST_TEXT_MAX) });
export const ownAccessRequest = z.strictObject({
  status: z.enum(ACCESS_REQUEST_STATUSES), message: z.string(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(), adminNote: z.string().nullable(),
});
export const adminAccessRequest = ownAccessRequest.extend({
  id: z.uuid(), user: z.strictObject({ id: z.uuid(), name: z.string(), email: z.string(), signedUpAt: z.iso.datetime() }),
});
export const accessRequestListQuery = z.strictObject({ ...pageQuery, status: z.enum(ACCESS_REQUEST_STATUSES).optional() });
export const dismissBody = z.strictObject({ note: z.string().trim().max(ACCESS_REQUEST_TEXT_MAX).optional() });

// admin-users.ts
export const ROLE_FILTERS = [...USER_ROLES, 'NONE'] as const;
export const userListQuery = z.strictObject({
  ...pageQuery, role: z.enum(ROLE_FILTERS).optional(),
  status: z.enum(USER_STATUSES).optional(), q: z.string().trim().min(1).max(USER_NAME_MAX).optional(),
});
export const adminUserItem = z.strictObject({
  id: z.uuid(), name: z.string(), email: z.string(), roles: z.array(z.enum(USER_ROLES)),
  status: z.enum(USER_STATUSES), lastLoginAt: z.iso.datetime().nullable(),
});
export const adminUserDetail = adminUserItem.extend({
  phone: z.string().nullable(), createdAt: z.iso.datetime(), version: z.int(),
  openOrders: z.strictObject({ draft: z.int(), pending: z.int(), approvedWithOpenLines: z.int() }),
});
export const updateUserBody = z.strictObject({ roles: roleSet.optional(), isActive: z.boolean().optional() })
  .refine((b) => b.roles !== undefined || b.isActive !== undefined);
```

## Operations

`refresh` and `user`-level routes, and every `admin` route, need `X-CSRF-Token` on
`POST`/`PATCH`/`DELETE` (R7). Every route also returns the common codes
(`VALIDATION_FAILED`, `CSRF_REJECTED`, `PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR`,
`SERVICE_UNAVAILABLE`, `CONCURRENCY_RETRY_EXHAUSTED`), plus, when not public,
`UNAUTHENTICATED`, `ACCESS_TOKEN_EXPIRED` and `ACCOUNT_DEACTIVATED`.

| operationId | Method and path | Access | Body / query | Success | Extra codes |
|---|---|---|---|---|---|
| `login` | `POST /auth/login` | public | `loginBody` | `200 me` + 3 cookies | `ACCOUNT_NOT_FOUND`, `ACCOUNT_LOCKED`, `PASSWORD_NOT_SET`, `INCORRECT_PASSWORD`, `ACCOUNT_NOT_VERIFIED`, `ACCOUNT_DEACTIVATED`, `RATE_LIMITED` |
| `signup` | `POST /auth/signup` | public | `signupBody` | `202` | `SIGNUP_DOMAIN_NOT_ALLOWED`, `EMAIL_IN_USE`, `RATE_LIMITED` |
| `verifyEmail` | `POST /auth/verify-email` | public | `tokenBody` | `204` | `INVALID_TOKEN` |
| `resendVerification` | `POST /auth/resend-verification` | public | `emailBody` | `202` | `ACCOUNT_NOT_FOUND`, `ACCOUNT_ALREADY_VERIFIED`, `ACCOUNT_DEACTIVATED`, `RATE_LIMITED` |
| `forgotPassword` | `POST /auth/forgot-password` | public | `emailBody` | `202` | `ACCOUNT_NOT_FOUND`, `ACCOUNT_DEACTIVATED`, `RATE_LIMITED` |
| `resetPassword` | `POST /auth/reset-password` | public | `resetPasswordBody` | `204` | `INVALID_TOKEN` |
| `refreshSession` | `POST /auth/refresh` | refresh | none | `204` + 3 cookies | `SESSION_EXPIRED`, `SESSION_REVOKED` |
| `logout` | `POST /auth/logout` | refresh | none | `204`, cookies cleared | `SESSION_EXPIRED`, `SESSION_REVOKED` |
| `logoutAll` | `POST /auth/logout-all` | refresh | none | `204`, cookies cleared | `SESSION_EXPIRED`, `SESSION_REVOKED` |
| `changePassword` | `POST /auth/change-password` | user | `changePasswordBody` | `204` | `ACCOUNT_LOCKED`, `RATE_LIMITED` (field `INCORRECT_PASSWORD`) |
| `listSessions` | `GET /auth/sessions` | user | `pageQuery` | `200 pageOf(sessionItem)` | |
| `revokeSession` | `DELETE /auth/sessions/:id` | user | `idParams` | `204` (cookies cleared if current) | `NOT_FOUND` |
| `getMe` | `GET /me` | user | none | `200 me` | |
| `updateMe` | `PATCH /me` | user | `updateMeBody` | `200 me` | (field `INVALID_PHONE`) |
| `getOwnAccessRequest` | `GET /me/access-request` | no-role | none | `200 ownAccessRequest` | `NOT_FOUND`, `FORBIDDEN` |
| `sendAccessRequest` | `POST /me/access-request` | no-role | `accessRequestBody` | `200 ownAccessRequest` | `FORBIDDEN`, `RATE_LIMITED` |
| `listUsers` | `GET /admin/users` | admin | `userListQuery` | `200 pageOf(adminUserItem)` | `NO_ROLE_ASSIGNED`, `FORBIDDEN` |
| `getUser` | `GET /admin/users/:id` | admin | `idParams` | `200 adminUserDetail` + `ETag` | `NO_ROLE_ASSIGNED`, `FORBIDDEN`, `NOT_FOUND` |
| `updateUser` | `PATCH /admin/users/:id` | admin, `If-Match` | `idParams`, `updateUserBody` | `200 adminUserDetail` + `ETag` | `NO_ROLE_ASSIGNED`, `FORBIDDEN`, `NOT_FOUND`, `SELF_MODIFICATION`, `ADMIN_NOT_MODIFIABLE`, `USER_UNVERIFIED`, `VERSION_CONFLICT` (fields `VERSION_REQUIRED`, `INVALID_ROLE_SET`) |
| `sendUserPasswordReset` | `POST /admin/users/:id/reset-password` | admin | `idParams` | `202` | `NO_ROLE_ASSIGNED`, `FORBIDDEN`, `NOT_FOUND`, `SELF_MODIFICATION`, `ADMIN_NOT_MODIFIABLE` |
| `listAccessRequests` | `GET /admin/access-requests` | admin | `accessRequestListQuery` | `200 pageOf(adminAccessRequest)` | `NO_ROLE_ASSIGNED`, `FORBIDDEN` |
| `dismissAccessRequest` | `POST /admin/access-requests/:id/dismiss` | admin | `idParams`, `dismissBody` | `200 adminAccessRequest` | `NO_ROLE_ASSIGNED`, `FORBIDDEN`, `NOT_FOUND`, `ACCESS_REQUEST_NOT_OPEN` |

Notes:
- **Sorts**: users `name, id`; access requests `updatedAt DESC, id DESC`; sessions
  `lastUsedAt DESC, id DESC`.
- **Admin reset**: ADR-0004's matrix gives it `PATCH`'s first two guards (themself →
  `409 SELF_MODIFICATION`, an Admin → `409 ADMIN_NOT_MODIFIABLE`). Any status gets the
  email (ADR-0016 sets no status rule); a deactivated user still can't log in after
  resetting. A `401 ACCOUNT_DEACTIVATED` here would send the *admin* to login (ADR-0018),
  so the target's status never produces a `401`.
- **Login body password** is checked only for presence and the 128 maximum; the policy
  applies when a password is set, never at login (an old password may predate a policy
  change).
- **Retry-After** is documented on every `423` and `429`; **Set-Cookie** on login,
  refresh, logout, logout-all and revoke; **ETag** on `getUser` and `updateUser`.

## Body-schema inventory (NFR-VAL-01)

`packages/contracts/tests/body-inventory.test.ts` `EXPECTED` gains every mutating
operation above with its exact field list and required flags. `refreshSession`,
`logout`, `logoutAll`, `revokeSession` and `sendUserPasswordReset` are listed as taking no
body.

## OpenAPI diff (against `main`)

Additive only; oasdiff's breaking check passes without the `breaking` label.
- 22 new paths/operations (table above); `/healthz` and `/readyz` unchanged.
- New security schemes: `accessCookie` (apiKey in cookie `po_access`), `refreshCookie`
  (`po_refresh`), `csrfHeader` (apiKey in header `X-CSRF-Token`). Each operation lists
  the schemes its access level requires; `public` lists none.
- New components: the schemas above, `Page*` envelopes, response headers `Retry-After`,
  `ETag`, `Set-Cookie`, request header `If-Match`.
- The `Problem.code` enum grows by the codes in [errors.md](errors.md); the field-code
  enum by its field codes. Adding enum values to a response is non-breaking for oasdiff.
