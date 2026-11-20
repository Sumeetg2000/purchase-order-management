# Errors: Slice 5 — Cancel and the remaining locks

## Registry

No new code. Existing codes gain cases:

| Code | Status | New case | Message (`detail` and web app) |
|---|---|---|---|
| `ORDER_LOCKED` | 409 | edit or delete of a `CANCELLED` order; `orderState.status` | "This order was cancelled and is closed." |
| `INVALID_STATE_TRANSITION` | 409 | cancel from any state but `APPROVED`; submit, withdraw, approve or reject of a `CANCELLED` order; `orderState.action` `CANCEL` | the existing per-action web message |
| `SELF_APPROVAL` | 403 | cancel by the owner (a Buyer+Approver) | "You can't cancel an order you raised." |
| `FORBIDDEN` | 403 | cancel by a pure Buyer (route) | "Only Approvers can cancel orders." |
| `FORBIDDEN` | 403 | cancel by an Admin (route) | "Admins can view orders but not change them." |
| `FORBIDDEN` / `ACCOUNT_DEACTIVATED` | 403 / 401 | the acting Approver lost APPROVER or was deactivated (under lock) | existing |
| `VALIDATION_FAILED` | 400 | `reason` missing → `REQUIRED`; empty or whitespace-only → `TOO_SHORT` ("Enter a reason."); over 500 → `TOO_LONG`; unknown field → `UNKNOWN_FIELD`; no `If-Match` → `VERSION_REQUIRED` | existing |

`ORDER_FULLY_RECEIVED` and `ORDER_NOT_RECEIVABLE` arrive with receipts (slice 6).

## Order of checks (ADR-0004)

1. `401` → CSRF → `403 NO_ROLE_ASSIGNED` → `403 FORBIDDEN` (route role; pure Buyer,
   Admin)
2. `400` (params, body, `If-Match`)
3. under lock: Approver re-check (`401` / `403`) → `404` (not readable) → `403
   SELF_APPROVAL` → `409 INVALID_STATE_TRANSITION` → `409 VERSION_CONFLICT`

## Database SQLSTATEs (mapped once in `db/errors.ts`)

| SQLSTATE | Name | Rule |
|---|---|---|
| `PO018` | `ORDER_CLOSED` | D9: any update of a rejected or cancelled order |
| `PO019` | `ORDER_CANCEL_REFUSED` | D10: cancel columns outside the cancel transition, or other columns changed with it |
| `PO016` | `SELF_DECISION_REFUSED` (existing) | D11: cancel not by the acting user, or by the owner |
| `23514` | check violation | `CANCELLED` without its record, or a record on another status; an invalid reason |
