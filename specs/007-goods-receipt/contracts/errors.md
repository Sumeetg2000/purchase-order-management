# Errors: Slice 6 — Goods receipt

## Registry (codes already listed in ADR-0007, live from this slice)

| Code | Status | Extra fields | When |
|---|---|---|---|
| `ORDER_NOT_RECEIVABLE` | 409 | `orderState: { status }` | a receipt on an order that isn't `APPROVED` |
| `RECEIPT_EXCEEDS_OUTSTANDING` | 409 | `lines: [{ lineId, position, outstanding, requested }]`, every offending line, in position order | any line would exceed its outstanding; nothing recorded |
| `ORDER_FULLY_RECEIVED` | 409 | — | a cancel of a fully received order |

Messages (web, by code): "This order can't receive goods: it is {status}." · "Nothing
was recorded." followed by one line each: "Line {position} has only {outstanding}
outstanding; you entered {requested}." · "This order has been fully received, so it can't be cancelled."

## New field codes (`VALIDATION_FAILED` details, ADR-0007)

| Code | Path | Message |
|---|---|---|
| `DATE_IN_FUTURE` | `body.receivedAt` | "Enter today's date or an earlier one." |
| `DATE_BEFORE_APPROVAL` | `body.receivedAt` | "Enter a date on or after the order's approval ({date})." |

Both are new values of the `FieldCode` enum in error responses: the `breaking` check is
expected to need the label (as in slice 5).

The same line twice in one command → `DUPLICATE_LINE_ID` on the later entry
(`body.lines.{i}.lineId`). Quantity is a whole number 1–1,000,000: `INVALID_FORMAT` for a
non-integer, `OUT_OF_RANGE` for 0, negative or above the maximum.

Reused: `REQUIRED`, `INVALID_FORMAT` (header and date), `OUT_OF_RANGE` (quantity),
`TOO_SHORT`/`TOO_LONG` (lines, note), `UNKNOWN_FIELD`, `LINE_NOT_FOUND`,
`DUPLICATE_LINE_ID`, `READ_ONLY_FIELD`.

## Order of checks (ADR-0004 precedence; research R5)

All locks are taken first (key → order → lines id asc → the caller's `users` row
`FOR SHARE`); the checks from step 4 on are then evaluated in this order on the locked
rows. Codes unchanged.

1. `401` → `403 NO_ROLE_ASSIGNED` → `403 FORBIDDEN` by role (pure Approver, Admin, no
   BUYER), before validation and lookup
2. `400` shape, `DATE_IN_FUTURE` (injected clock)
3. `409 IDEMPOTENCY_KEY_REUSED` / replay
4. `404` → `403 NOT_ORDER_OWNER`
5. the caller's locked row: `401 ACCOUNT_DEACTIVATED`, `403 FORBIDDEN`
6. `409 ORDER_NOT_RECEIVABLE`
7. `400 LINE_NOT_FOUND`, then `400 DATE_BEFORE_APPROVAL`
8. `409 RECEIPT_EXCEEDS_OUTSTANDING` (every offending line)

Cancel: unchanged up to the version check, then `409 ORDER_FULLY_RECEIVED`.

## Database SQLSTATEs (mapped once in `db/errors.ts`, all `INTERNAL_ERROR`)

`PO020 ORDER_NOT_RECEIVABLE` · `PO021 RECEIPT_NOT_BY_OWNER` · `PO022
RECEIPT_EXCEEDS_ORDERED` · `PO023 RECEIPT_IMMUTABLE` · `PO024 RECEIPT_BEFORE_APPROVAL` · `PO025 RECEIPT_DATE_TOO_LATE` (D17 backstop) ·
`PO019` gains the fully-received branch · `PO005` covers `received_quantity`.
