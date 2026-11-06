# Error codes: Slice 2 — Vendors

Added to the single registry (`packages/contracts/src/errors.ts`), each with a message in
`frontend/src/errors/messages.ts`.

| Code | Status | When | Extension |
|---|---|---|---|
| `DUPLICATE_VENDOR_NAME` | 409 | create or rename to a name whose normalised form an active or inactive vendor already has; also a retried create | `existingVendor: { id, name }` |
| `INVALID_STATE_TRANSITION` | 409 | deactivate an inactive vendor, reactivate an active one (orders reuse it from slice 4) | — |
| `VENDOR_INACTIVE` | 409 | `requireActiveVendor` on an inactive vendor (first API use: order create, slice 3) | — |

Field code (inside `VALIDATION_FAILED.details`):

| Code | When |
|---|---|
| `VENDOR_NOT_FOUND` | `requireActiveVendor` on an id with no vendor; `path` is the caller's field, e.g. `body.vendorId` |

Existing codes used: `VALIDATION_FAILED` (`REQUIRED`, `UNKNOWN_FIELD`, `INVALID_FORMAT`,
`TOO_SHORT`, `TOO_LONG`, `OUT_OF_RANGE`, `VERSION_REQUIRED`), `NOT_FOUND`,
`VERSION_CONFLICT`, `FORBIDDEN`, `NO_ROLE_ASSIGNED`, `UNAUTHENTICATED`.

Messages (web app):
- `DUPLICATE_VENDOR_NAME`: "A vendor with this name already exists." plus a link
  "Open {existingVendor.name}".
- `INVALID_STATE_TRANSITION`: "This vendor's status has already changed. Reload to see it."
- `VENDOR_INACTIVE`: "This vendor is deactivated. Reactivate it or choose another vendor."
- Field `VENDOR_NOT_FOUND`: "This vendor no longer exists."

Check order per request (ADR-0004): `401` → CSRF → `403 NO_ROLE_ASSIGNED` → `403
FORBIDDEN` → `400` shape (incl. `VERSION_REQUIRED`) → `404` → `409 VERSION_CONFLICT` →
`409 INVALID_STATE_TRANSITION` / `DUPLICATE_VENDOR_NAME`.
