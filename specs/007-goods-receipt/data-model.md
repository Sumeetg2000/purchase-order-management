# Data model: Slice 6 — Goods receipt and concurrency

Migration `0016_receipts`, in two parts like slices 4 and 5: part 1 (tables, grants,
indexes) lands with the foundational tasks; part 2 (triggers and rules) lands after the
attack tests are seen failing on part 1. Decisions in [research.md](research.md).

## `goods_receipts` (new): the receipt, one per delivery

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid` PK | default `gen_random_uuid()`; `UNIQUE (id, order_id)` for the lines' key |
| `order_id` | `uuid` NOT NULL | FK `purchase_orders`, `ON DELETE RESTRICT` |
| `received_on` | `date` NOT NULL | the India receipt date; ≥ the order's approval date in India time (D14); ≤ the database's India date + 1 day (D17, a backstop); the exact "not after today" is the service's (R4) |
| `recorded_at` | `timestamptz` NOT NULL | set to `now()` by the insert trigger, whatever is sent |
| `recorded_by` | `uuid` NOT NULL | FK `users`; the order's owner and the actor in context (D13) |
| `note` | `text` NULL | CHECK trimmed plain text, 1–500 characters, no control character but line breaks (the reason rule's character set); absent is `NULL` |

A receipt has at least one line, written in the same statement (R1).

## `goods_receipt_lines` (new): what one receipt received, per order line

| Column | Type | Rule |
|---|---|---|
| `receipt_id` | `uuid` NOT NULL | with `order_id`: FK `goods_receipts (id, order_id)`, `ON DELETE RESTRICT` |
| `order_id` | `uuid` NOT NULL | the receipt's order, and the line's (both keys) |
| `line_id` | `uuid` NOT NULL | with `order_id`: FK `order_lines (id, order_id)`, `ON DELETE RESTRICT` |
| `quantity` | `integer` NOT NULL | CHECK `quantity BETWEEN 1 AND 1000000` |

Primary key `(receipt_id, line_id)`: a receipt names a line once.

Grants: `po_app` `SELECT` on both; `INSERT (order_id, received_on, recorded_by, note)` on
`goods_receipts`; `INSERT (receipt_id, order_id, line_id, quantity)` on
`goods_receipt_lines`. Nothing else, for any role but `po_owner` (D16 refuses even that).

Indexes (sign-off, research R10): `goods_receipts_order_recorded_idx (order_id,
recorded_at DESC, id DESC)`, `goods_receipts_id_order_key UNIQUE (id, order_id)`,
`goods_receipts_recorded_by_idx (recorded_by)`, `goods_receipt_lines_line_idx
(line_id)`; `order_lines_id_order_key UNIQUE (id, order_id)`.

## `order_lines` (changed)

- `received_quantity`: unchanged column and CHECK (`0 ≤ received ≤ quantity`); now
  written only by `goods_receipt_lines_after_insert` under the `po.receipts` flag. New row guard
  `order_lines_received_guard` (`BEFORE INSERT OR UPDATE`): a non-zero insert or a change
  without the flag → `PO005`.
- `order_lines_after_update`: when only `received_quantity` changed, calls
  `recompute_open_lines` instead of `recompute_orders` (research R3).

## `purchase_orders` (unchanged columns)

- `open_line_count` written by `recompute_open_lines` for receipts (flag `po.recompute`,
  guard `PO005` unchanged). `version` never moves on a receipt.
- `purchase_orders_cancel_guard` (D10) adds: `→ CANCELLED` with `OLD.open_line_count = 0`
  → `PO019`.

## Triggers and functions (part 2)

| Object | Kind | Does |
|---|---|---|
| `goods_receipts_before_insert` | row, `BEFORE INSERT` | sets `recorded_at := now()` |
| `goods_receipts_after_insert` | statement, `AFTER INSERT`, `new_receipts` | a receipt with no line → `23514` (`goods_receipts_has_lines`) |
| `goods_receipt_lines_after_insert` | statement, `AFTER INSERT`, `new_lines` | locks (orders, then lines, id order); D16 (a line on an earlier transaction's receipt), D12, D13, D14, D17, D15 on the sums over every receipt in the statement (research R2); one set-based line update |
| `receipts_immutable` | statement, `BEFORE UPDATE OR DELETE OR TRUNCATE`, on both tables | D16 `PO023` |
| `require_actor_context` | statement, on both tables | as on every audited table |
| `recompute_open_lines(uuid[])` | function, `SECURITY DEFINER` | locks the orders in id order, writes `open_line_count` only, counts runs in `po.open_line_recompute_count` |
| `order_lines_received_guard` | row, `BEFORE INSERT OR UPDATE` | `PO005` outside the flag |

SQLSTATEs (mapped once in `backend/src/db/errors.ts`): `PO020 ORDER_NOT_RECEIVABLE`,
`PO021 RECEIPT_NOT_BY_OWNER`, `PO022 RECEIPT_EXCEEDS_ORDERED`, `PO023 RECEIPT_IMMUTABLE`,
`PO024 RECEIPT_BEFORE_APPROVAL`, `PO025 RECEIPT_DATE_TOO_LATE`. As for every class-PO SQLSTATE, each means the service
let through something it should have refused (it checks the same rules first, under the
same locks), so each maps to `INTERNAL_ERROR`, logged with its name.

## `idempotency_keys` (changed)

The operation CHECK gains `recordReceipt` (pinned to `IDEMPOTENT_OPERATIONS` by the
existing test).

## Reconciliation (`backend/src/db/reconciliation.sql`)

Adds INV-3: per line, `received_quantity = coalesce(Σ goods_receipt_lines.quantity,
0)`; INV-4 and
INV-6 unchanged.

## Audit

`GOODS_RECEIPT_RECORDED`, one per receipt line, entity the order (`order_id`,
`po_number`), actor `USER` acting as `BUYER`; details `{ receiptId, lineId, position,
quantity, receivedBefore, receivedAfter, outstandingAfter, receivedOn, recordedAt, note
}`, `receiptId` the receipt's id, the same on every entry of one receipt. Written by one `INSERT … SELECT FROM unnest(…)` (`writeAuditBatch`).

## Lock order (ADR-0006 row to add)

| Command | Locks, in order |
|---|---|
| receipt | idempotency key → order `FOR UPDATE` → the command's lines (id asc) `FOR UPDATE` → the caller's `users` row `FOR SHARE` |
| cancel (changed) | unchanged locks; reads `open_line_count` under the order lock |

## Plan fixture (ADR-0012 amendment, sign-off research R13.7)

Approved 89,000: 45,000 fully received, 25,000 partly, 19,000 nothing. Cancelled 1,000:
500 partly, 500 nothing. 1–3 receipts per received order (≈1.5M receipt lines),
inserted set-based through the trigger so the derived columns are real; reconciliation runs on the fixture.

## State transitions after this slice

Unchanged. A receipt is not a transition; a fully received order stays `APPROVED`
(research R4). T10's "not fully received" guard is now enforced, in the service (`409
ORDER_FULLY_RECEIVED`) and in the database (D10).
