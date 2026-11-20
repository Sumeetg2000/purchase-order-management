# API: Slice 5 — Cancel

Zod first (`packages/contracts`); the OpenAPI diff is additive. Research R5–R7.

## Constants (`packages/contracts/src/orders.ts`, `approvals.ts`)

- `ORDER_ACTIONS` gains `'CANCEL'`.
- `ORDER_TRANSITIONS` gains `['APPROVED', 'CANCELLED']` (pinned to the SQL rows).
- `ORDER_CANCEL_APPROVER_ONLY_MESSAGE = 'Only Approvers can cancel orders.'` (ADR-0004,
  2026-11-20).
- `ORDER_CANCEL_FORBIDDEN_DETAIL = { ADMIN: ORDER_ADMIN_READ_ONLY_MESSAGE, BUYER:
  ORDER_CANCEL_APPROVER_ONLY_MESSAGE }`.
- `ORDER_LOCKED_MESSAGES.CANCELLED = 'This order was cancelled and is closed.'`
- `SELF_APPROVAL` detail by action (signed off, R10 Q2): approve and reject keep "You can't
  approve or reject an order you raised."; cancel "You can't cancel an order you raised."
- The owner-can't-act marker on approved orders (spec FR-017a): `OWNER_INACTIVE_APPROVED_MARKER`
  = "Its owner can no longer act on it, so receipts can't be recorded." and
  `OWNER_INACTIVE_CANCEL_HINT` = "To close it, cancel it, and a buyer can raise a new
  order if the goods are still needed." (web only; one constant each).

## Schemas (`schemas/orders.ts`)

`order` gains:

```ts
cancellation: z.strictObject({
  cancelledBy: z.strictObject({ id: z.uuid(), name: z.string() }),
  cancelledAt: z.iso.datetime(),
  reason: z.string(),
}).nullable()
```

`null` unless `status === 'CANCELLED'`. Added to the order's read-only field list, so a
body carrying `cancellation` (or `cancelledBy`, `cancelledAt`, `cancelReason`) is refused
with `READ_ONLY_FIELD`. Order list items unchanged.

## Operations (`operations.ts`)

| Operation | Method, path | Access | Body | `If-Match` | 200 | Errors (beyond the standard set) |
|---|---|---|---|---|---|---|
| `cancelOrder` (new) | `POST /orders/:id/cancel` | role `APPROVER`; `forbiddenDetail: ORDER_CANCEL_FORBIDDEN_DETAIL` | `decisionReasonBody` (`{ reason }`, strict) | required | `order`, `ETag` | `ACCOUNT_DEACTIVATED`, `NOT_FOUND`, `SELF_APPROVAL`, `INVALID_STATE_TRANSITION`, `VERSION_CONFLICT` |
| `getOrder`, `updateOrder`, `deleteOrder` (changed) | — | — | — | — | `order` gains `cancellation` | `ORDER_LOCKED` now also for `CANCELLED` |

Summary for `cancelOrder`: "Cancel an approved order you don't own, with a reason and its
current version; cancelling is final."

Route-table, CSRF and body-inventory tests gain the operation (deny-by-default holds).

## OpenAPI diff (additive)

- `+ POST /api/orders/{id}/cancel` (`cancelOrder`)
- `Order.cancellation` (nullable object), `OrderAction` enum `+ CANCEL`
- no removed or narrowed field; `check:contract` passes without a breaking-change approval
