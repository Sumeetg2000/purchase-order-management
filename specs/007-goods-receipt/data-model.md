# Data model: Slice 6 — Goods receipt and concurrency

Migration `0016_receipts`, in two parts like slices 4 and 5: part 1 (tables, grants,
indexes) lands with the foundational tasks; part 2 (triggers and rules) lands after the
attack tests are seen failing on part 1. Decisions in [research.md](research.md).

## `receipts` (new)

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid` PK | default `gen_random_uuid()` |
| `order_id` | `uuid` NOT NULL | with `line_id`: FK `order_lines (id, order_id)`, `ON DELETE RESTRICT` |
| `line_id` | `uuid` NOT NULL | see above |
| `quantity` | `integer` NOT NULL | CHECK `quantity BETWEEN 1 AND 1000000` |
| `received_at` | `date` NOT NULL | the India receipt date; ≥ the order's approval date in India time (D14); ≤ the database's India date + 1 day (D17, a backstop); the exact "not after today" is the service's (R4) |
| `recorded_at` | `timestamptz` NOT NULL | set to `now()` by the insert trigger, whatever is sent |
| `recorded_by` | `uuid` NOT NULL | FK `users`; the order's owner and the actor in context (D13) |
| `note` | `text` NULL | CHECK plain text, 0–500 characters (the reason rule's character set) |

Grants: `po_app` `SELECT`; `INSERT (order_id, line_id, quantity, received_at,
recorded_by, note)`. Nothing else, for any role but `po_owner` (D16 refuses even that).

Indexes (sign-off, research R10): `receipts_order_recorded_idx (order_id, recorded_at
DESC, id DESC)`, `receipts_line_idx (line_id)`, `receipts_recorded_by_idx
(recorded_by)`; `order_lines_id_order_key UNIQUE (id, order_id)`.

## `order_lines` (changed)

- `received_quantity`: unchanged column and CHECK (`0 ≤ received ≤ quantity`); now
  written only by `receipts_after_insert` under the `po.receipts` flag. New row guard
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
| `receipts_before_insert` | row, `BEFORE INSERT` | sets `recorded_at := now()` |
| `receipts_after_insert` | statement, `AFTER INSERT`, `new_receipts` | D12, D13, D14, D17, D15 (research R2 steps 1–4); one set-based line update |
| `receipts_immutable` | statement, `BEFORE UPDATE OR DELETE OR TRUNCATE` | D16 `PO023` |
| `require_actor_context` | statement | as on every audited table |
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

Adds INV-3: per line, `received_quantity = coalesce(Σ receipts.quantity, 0)`; INV-4 and
INV-6 unchanged.

## Audit

`GOODS_RECEIPT_RECORDED`, one per receipt row, entity the order (`order_id`,
`po_number`), actor `USER` acting as `BUYER`; details `{ receiptId, lineId, position,
quantity, receivedBefore, receivedAfter, outstandingAfter, receivedAt, recordedAt, note
}`. Written by one `INSERT … SELECT FROM unnest(…)` (`writeAuditBatch`).

## Lock order (ADR-0006 row to add)

| Command | Locks, in order |
|---|---|
| receipt | idempotency key → order `FOR UPDATE` → the command's lines (id asc) `FOR UPDATE` → the caller's `users` row `FOR SHARE` |
| cancel (changed) | unchanged locks; reads `open_line_count` under the order lock |

## Plan fixture (ADR-0012 amendment, sign-off research R13.7)

Approved 89,000: 45,000 fully received, 25,000 partly, 19,000 nothing. Cancelled 1,000:
500 partly, 500 nothing. 1–3 receipts per received line (≈1.5M), inserted set-based
through the trigger so the derived columns are real; reconciliation runs on the fixture.

## State transitions after this slice

Unchanged. A receipt is not a transition; a fully received order stays `APPROVED`
(research R4). T10's "not fully received" guard is now enforced, in the service (`409
ORDER_FULLY_RECEIVED`) and in the database (D10).
