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
  receivedOn: isoDate,                       // 'YYYY-MM-DD', the India receipt date
  note: plainText(0, 500).nullable().optional(),
  lines: z.array(z.strictObject({ lineId: uuid, quantity: int(1, 1_000_000) }))
          .min(1).max(500),                  // the same lineId twice: DUPLICATE_LINE_ID
});
// The receipt document (research R1): one per command, with a line per order line.
recordedReceipt = { id, receivedOn, recordedAt, note, receiptProgress,
  lines: [{ lineId, position, quantity, receivedBefore, receivedAfter, outstandingAfter }] };
receiptSummary = { id, receivedOn, recordedAt, recordedBy: { id, name }, note, lineCount };
receiptPage = page(receiptSummary);          // the shared envelope; pages cut receipts
receiptDetail = { id, receivedOn, recordedAt, recordedBy: { id, name }, note,
  lines: [{ line: { id, position, description }, quantity }] };   // ≤ 500, position order

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
| `listOrderReceipts` | `GET /api/orders/{id}/receipts` | whoever can read the order | — | `200` `receiptPage` (receipt summaries newest first, each with `lineCount`) |
| `getOrderReceipt` | `GET /api/orders/{id}/receipts/{receiptId}` | whoever can read the order | — | `200` `receiptDetail` (its lines in position order); `404` when the order is unreadable or the receipt isn't on it |
| `getOrder`, `listOrders` | unchanged paths | unchanged | — | new fields |
| `getAdminUser`, `updateAdminUser` | unchanged paths | unchanged | — | `openOrders` |

`recordReceipt` errors: `400 VALIDATION_FAILED`, `401`, `403 NO_ROLE_ASSIGNED`, `403
FORBIDDEN`, `403 NOT_ORDER_OWNER`, `404`, `409 IDEMPOTENCY_KEY_REUSED`, `409
ORDER_NOT_RECEIVABLE`, `409 RECEIPT_EXCEEDS_OUTSTANDING`, `503`.
`cancelOrder` gains `409 ORDER_FULLY_RECEIVED`.

## OpenAPI diff (additive)

- 2 new paths (`/api/orders/{id}/receipts`: `post`, `get`;
  `/api/orders/{id}/receipts/{receiptId}`: `get`), 5 new schemas (`RecordReceiptBody`,
  `RecordedReceipt`, `ReceiptSummary`, `ReceiptPage`, `ReceiptDetail`), 1 new enum
  (`ReceiptProgress`).
- New required response properties on `Order`, `OrderLine`, `OrderListItem`,
  `AdminUserDetail`; new error responses on `cancelOrder`.
- New `FieldCode` values (`DATE_IN_FUTURE`, `DATE_BEFORE_APPROVAL`) and `ErrorCode`
  values: both are `x-extensible-enum` (ADR-0008), so they are non-breaking and need no
  `breaking` label; only a value added to a fixed enum (such as `orderState.action`)
  would. No field is removed or narrowed.
