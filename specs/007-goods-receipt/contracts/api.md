# API contract: Slice 6 — Goods receipt

Zod first (`packages/contracts/src`), OpenAPI generated. Reviewed before any service
code (constitution gate 2). Decisions: [research.md](../research.md) R7–R9.

## Constants (`packages/contracts/src/receipts.ts`, new)

- `RECEIPT_PROGRESS = ['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED']`
- `RECEIPT_QUANTITY_MIN = 1`, `RECEIPT_QUANTITY_MAX = LINE_QUANTITY_MAX`
  (1,000,000, imported, not copied); `RECEIPT_NOTE_MAX = 500`; lines per command
  `ORDER_LINES_MIN`–`ORDER_LINES_MAX` (imported)
- `RECEIPT_TIME_ZONE = 'Asia/Kolkata'` (one constant; the SQL copy in D14 pinned by a test)
- `IDEMPOTENT_OPERATIONS` gains `recordReceipt` (backend; the table CHECK pinned)
- Web text, one place: the received summary helper, the badges, the fully-received
  warning, the admin open-orders sentence (research R8, R12)

## Schemas

```ts
// schemas/receipts.ts
recordReceiptBody = z.strictObject({
  receivedAt: isoDate,                       // 'YYYY-MM-DD'
  note: plainText(0, 500).nullable().optional(),
  lines: z.array(z.strictObject({ lineId: uuid, quantity: int(1, 1_000_000) }))
          .min(1).max(500),                  // DUPLICATE_LINE_ID refined
});
recordedReceipt = { receivedAt, recordedAt, note, receiptProgress,
  receipts: [{ id, lineId, position, quantity, receivedBefore, receivedAfter, outstandingAfter }] };
receiptItem = { id, line: { id, position, description }, quantity, receivedAt,
  recordedAt, recordedBy: { id, name }, note };
receiptPage = page(receiptItem);             // the shared page envelope

// schemas/orders.ts (additive)
orderLine        += { receivedQuantity: int, outstandingQuantity: int }   // read-only
order            += { receiptProgress, receivedLines: { complete, partly, total } }
orderListItem    += { receiptProgress }

// schemas/admin-users.ts (additive)
adminUserDetail  += { openOrders: { draft: int, pending: int, approvedWithOpenLines: int } }
```

All new response fields are read-only: a request carrying them is refused
(`READ_ONLY_FIELD`), as for the existing derived fields.

## Operations (`operations.ts`)

| Operation | Method, path | Access | Headers | Success |
|---|---|---|---|---|
| `recordReceipt` | `POST /api/orders/{id}/receipts` | BUYER (route); owner (service) | `Idempotency-Key` required; no `If-Match` | `201` `recordedReceipt` |
| `listOrderReceipts` | `GET /api/orders/{id}/receipts` | whoever can read the order | — | `200` `receiptPage` |
| `getOrder`, `listOrders` | unchanged paths | unchanged | — | new fields |
| `getAdminUser`, `updateAdminUser` | unchanged paths | unchanged | — | `openOrders` |

`recordReceipt` errors: `400 VALIDATION_FAILED`, `401`, `403 NO_ROLE_ASSIGNED`, `403
FORBIDDEN`, `403 NOT_ORDER_OWNER`, `404`, `409 IDEMPOTENCY_KEY_REUSED`, `409
ORDER_NOT_RECEIVABLE`, `409 RECEIPT_EXCEEDS_OUTSTANDING`, `503`.
`cancelOrder` gains `409 ORDER_FULLY_RECEIVED`.

## OpenAPI diff (additive)

- 1 new path (`/api/orders/{id}/receipts`: `post`, `get`), 4 new schemas
  (`RecordReceiptBody`, `RecordedReceipt`, `ReceiptItem`, `ReceiptPage`), 1 new enum
  (`ReceiptProgress`).
- New required response properties on `Order`, `OrderLine`, `OrderListItem`,
  `AdminUserDetail`; new error responses on `cancelOrder`.
- No removed or narrowed field, no changed enum: the `breaking` check is expected to pass
  without the label.
