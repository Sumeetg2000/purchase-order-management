# Errors: Slice 4 — Submission, routing, approval, rejection and withdrawal

## Registry additions (`packages/contracts/src/errors.ts`), research R8

| Code | Status | New? | When | Message (`detail` and web app) |
|---|---|---|---|---|
| `ORDER_PENDING_APPROVAL` | 409 | **new** (ADR-0001/0007, 2026-11-17) | edit or delete of a `PENDING_APPROVAL` order | "This order is waiting for approval. Withdraw it to make changes." |
| `ORDER_OWNER_INACTIVE` | 409 | **new** (ADR-0001/0007, 2026-11-17) | approve while the owner is deactivated or lacks BUYER | "The buyer who raised this order can no longer act on it. Reject it, or approve once their access is restored." |
| `ORDER_LOCKED` | 409 | in ADR-0007, first in the registry | edit or delete of an `APPROVED` or `REJECTED` order; `details.status` | `APPROVED`: "This order is approved and locked." · `REJECTED`: "This order was rejected and is closed. Raise a new order instead." |
| `NOT_ORDER_OWNER` | 403 | in ADR-0007, first in the registry | submit, withdraw, edit, delete by a Buyer+Approver on another buyer's non-draft order | "Only the buyer who raised this order can do that." |
| `SELF_APPROVAL` | 403 | in ADR-0007, first in the registry | approve or reject by the order's owner | "You can't approve or reject an order you raised." |

`INVALID_STATE_TRANSITION` (409, existing) now also covers orders: submit, withdraw,
approve or reject from the wrong state, with `details.status` and `details.action`.

No new field codes. `DUPLICATE_APPROVER` stays absent (registry test).

## Order of checks

1. `401` → CSRF → `403 NO_ROLE_ASSIGNED` → `403 FORBIDDEN` (route role; `detail` by role
   set: Admin "Admins can view orders but not change them.", pure Approver on an order write "Approvers can review orders but not change them.", pure Buyer on approve or reject "Only Approvers can approve or reject orders."). Body unread.
2. `400`: `If-Match` (`VERSION_REQUIRED`), body schema (`UNKNOWN_FIELD`, reason
   `REQUIRED`/`TOO_LONG`/`INVALID_FORMAT`).
3. Transaction, after research R6's locks: approve and reject re-check the acting
   Approver (`401 ACCOUNT_DEACTIVATED`, `403 FORBIDDEN`) → `404` → `403` (`NOT_ORDER_OWNER` |
   `SELF_APPROVAL`) → `409` state (`ORDER_PENDING_APPROVAL`, `ORDER_LOCKED`,
   `INVALID_STATE_TRANSITION`) → `409 VERSION_CONFLICT` → `409 VENDOR_INACTIVE` (submit,
   approve) → `409 ORDER_OWNER_INACTIVE` (approve).

## Database errors (`backend/src/db/errors.ts`, all → `INTERNAL_ERROR`)

| SQLSTATE | Name | Meaning |
|---|---|---|
| `PO012` | `APPROVAL_STEP_REFUSED` | an illegal step insert, move, change after close, or delete |
| `PO013` | `APPROVAL_ROUND_REFUSED` | an illegal round insert, update, or delete; `AUTO_APPROVED` outside `SYSTEM` |
| `PO014` | `ORDER_APPROVAL_INCONSISTENT` | at commit: status, round, chain or dates disagree |
| `PO015` | `ORDER_SUBMISSION_FIELD_LOCKED` | vendor or submission columns changed outside a transition |
| `PO016` | `SELF_DECISION_REFUSED` | a step decided by the owner, or by someone other than the acting user |
| `PO017` | `APPROVAL_POLICY_IMMUTABLE` | a policy row changed, or `set_approval_policy` outside `OPERATOR` or with invalid tiers |
