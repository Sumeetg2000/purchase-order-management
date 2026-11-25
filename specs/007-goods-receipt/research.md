# Research: Slice 6 — Goods receipt and concurrency

Decisions for `specs/007-goods-receipt`. Owner steer (2026-11-24) is marked **[steer]**;
everything needing the owner's sign-off is listed in R13.

## R1 The receipt document: `goods_receipts` and `goods_receipt_lines` (owner, 2026-11-25)

- **Decision**: a receipt is a document, as a goods received note (GRN) is: one header
  per delivery and one row per line it covers.
  - `goods_receipts`: `id uuid` (default `gen_random_uuid()`), `order_id uuid` (FK
    `purchase_orders`), `received_on date` (the India receipt date; a date, beside the
    `recorded_at` timestamp), `recorded_at timestamptz` (set to `now()` by the insert
    trigger whatever the caller sends), `recorded_by uuid` (FK `users`), `note text NULL`
    (CHECK: trimmed plain text of 1–500 characters, no control characters but line
    breaks, as the reason rule; absent is `NULL`). `UNIQUE (id, order_id)`, the target
    of the lines' receipt key.
  - `goods_receipt_lines`: `receipt_id uuid`, `order_id uuid`, `line_id uuid`, `quantity
    integer` (CHECK 1–1,000,000, the line quantity rule); primary key `(receipt_id,
    line_id)`, so a receipt names a line once.
  - Two composite keys keep every line on the receipt's order: `(receipt_id, order_id)`
    references `goods_receipts (id, order_id)` and `(line_id, order_id)` references
    `order_lines (id, order_id)` (`order_lines` gains `UNIQUE (id, order_id)`), both `ON
    DELETE RESTRICT`.
  - A receipt has at least one line, and its lines are written with it: the header's
    statement trigger refuses a receipt with no line (`23514`, constraint
    `goods_receipts_has_lines`), and the lines' trigger refuses a line added to a receipt
    recorded in an earlier transaction (`PO023`, D16). The service writes both in **one**
    statement, a CTE (R6).
  - `po_app`: `SELECT` on both; `INSERT (order_id, received_on, recorded_by, note)` on
    `goods_receipts` and `INSERT (receipt_id, order_id, line_id, quantity)` on
    `goods_receipt_lines`; no `UPDATE`, `DELETE` or `TRUNCATE` on either.
  - The `require_actor_context` statement trigger on both, as on every audited table.
- **Rationale**: the date, the note and the recorder belong to the delivery, not to each
  line, so they are stored once; the history lists deliveries with their lines (R7);
  the audit entries of one delivery share its id. Carrying `order_id` on both tables
  answers "has this order any receipt" (the list badge, R9) and the history from one
  index without reading lines; the composite keys make the copies impossible to get
  wrong.
- **Alternatives**: one flat `receipts` table, a row per line per command (the first
  plan: date, note and recorder repeated per line, and nothing but a shared
  `recorded_at` grouping one delivery's lines); `line_id` only on the lines (every
  per-order question joins lines: a 500-line order reads 500 index entries for one
  EXISTS).

## R2 Received quantity: stored, maintained by a statement trigger, guarded [steer]

- **Decision**: `order_lines.received_quantity` (it exists since slice 3, with `CHECK
  (received_quantity BETWEEN 0 AND quantity)`) is maintained by
  `goods_receipt_lines_after_insert`, an `AFTER INSERT … FOR EACH STATEMENT` trigger on
  `goods_receipt_lines` with a `new_lines` transition table, `SECURITY DEFINER` (runs as
  `po_owner`). The receipt rules all live there, read through each line's receipt (every
  receipt has a line, R1). Per statement it:
  1. locks the lines' orders in id order, then the lines in id order (both `FOR NO KEY
     UPDATE`: no-ops under the service's `FOR UPDATE`, and no deadlock with a raw
     insert's foreign-key `KEY SHARE`); every lock is taken before any check;
  2. refuses a line added to a receipt recorded in an earlier transaction (D16), a
     non-`APPROVED` order (D12), a receipt not recorded by the order's owner as the actor
     in context (D13), dated before the order's approval date in India time (D14), or
     after the database's India date + 1 day (D17, a loose backstop);
  3. refuses any line whose `received_quantity + Σ new quantity > quantity`, summed over
     every receipt in the statement, naming the first such line by position in the
     message (`PO022`; the service lists every one first); the CHECK stays as a last net;
  4. sets the transaction-local flag `po.receipts` and runs **one** `UPDATE order_lines …
     FROM (SELECT line_id, sum(quantity) … GROUP BY line_id)`, then clears the flag.
  - A new row-level guard on `order_lines` refuses any change to `received_quantity`
    without the flag, and an `INSERT` with a non-zero value, for every role (`PO005
    DERIVED_VALUE_READ_ONLY`, as for the order's derived columns): a privileged role gets
    a loud error, never a silent fix.
  - The database therefore refuses received > ordered on **every** insert path, raw SQL
    as `po_app` or as `po_owner` included; the service's check exists only to name the
    line in a `409`.
- **Reconciliation**: INV-3 (`received_quantity = Σ goods_receipt_lines.quantity` per line) joins
  the reconciliation query, beside INV-4 and INV-6.
- **Rationale**: stored like the total and the open line count (ADR-0003), so the order
  read, the list badge and slice 7's report never sum 1.5M receipt lines.

## R3 Open line count: recomputed once per receipt statement, total never

- **Decision**: `order_lines_after_update` today calls `recompute_orders`, which also
  sums the total. A receipt changes only `received_quantity`, so the trigger now calls a
  new `recompute_open_lines(order_ids)` when nothing else changed: the same locking and
  flag (`po.recompute`), writing `open_line_count` only. It counts its runs in
  `po.open_line_recompute_count`.
- **Result** (NFR-PERF-03, "receipt = 0"): a receipt of any number of lines runs
  `recompute_orders` 0 times and `recompute_open_lines` once. The trigger-efficiency
  test asserts both counts for a 1-line and a 500-line receipt.
- A line completing changes `open_line_count`, so the order row is updated (and its
  `updated_at` moves) but **not its `version`**: receipts never conflict with an
  `If-Match` (ADR-0006).

## R4 What the database refuses (rules D12–D17, extending D1–D11)

| Rule | Refused | SQLSTATE |
|---|---|---|
| **D12** | a receipt on an order that isn't `APPROVED` | `PO020 ORDER_NOT_RECEIVABLE` |
| **D13** | a receipt whose `recorded_by` isn't the order's owner, or isn't the actor in context | `PO021 RECEIPT_NOT_BY_OWNER` |
| **D14** | a `received_on` before the order's approval date (India time) | `PO024 RECEIPT_BEFORE_APPROVAL` |
| **D15** | received above ordered, on any insert path | `PO022 RECEIPT_EXCEEDS_ORDERED` |
| **D16** | any `UPDATE`, `DELETE` or `TRUNCATE` of `goods_receipts` or `goods_receipt_lines`, any role; a line added to a receipt recorded in an earlier transaction | `PO023 RECEIPT_IMMUTABLE` |
| **D17** | a `received_on` after the database's India date + 1 day (signed off 2026-11-24) | `PO025 RECEIPT_DATE_TOO_LATE` |
| **D10 extended** | `APPROVED → CANCELLED` while `open_line_count = 0` (fully received) | `PO019 ORDER_CANCEL_REFUSED` |
| guard | `received_quantity` written outside R2's trigger | `PO005 DERIVED_VALUE_READ_ONLY` |

- **"Not after today"**: exact in the service only (`400 DATE_IN_FUTURE`, from the
  injected clock); a database check on its own clock would contradict an injected date
  near midnight. The database keeps a loose backstop (D17, owner sign-off): `received_on
  ≤ (now() AT TIME ZONE 'Asia/Kolkata')::date + 1`, so raw SQL can't record a date far in
  the future, and a test clock one day ahead still passes. The time-zone literal is
  pinned to `RECEIPT_TIME_ZONE` by a test, as for D14.
- **Full receipt doesn't change the order's status.** An order stays `APPROVED` when its
  last line is fully received; receipt progress is derived (ADR-0001, unchanged). No
  transition is added, and the state table is untouched; only T10's "not fully
  received" guard goes live (D10 extended, ADR-0001 already names it for slice 6).

## R5 Lock order and checks [steer: order → lines, ADR-0006]

- **Lock order**: idempotency key (its row, as in create) → order `FOR UPDATE` → the
  command's lines, id ascending, `FOR UPDATE` → the caller's `users` row `FOR SHARE`
  (last, re-checked as approve and cancel re-check the acting Approver). The trigger's
  own locks are on rows already held. No `users` row is locked before an order or line.
- **Why the key first**: it is not order data; nothing that locks an order ever waits on
  a key, so no cycle can form (as for create, ADR-0006).
- **Cancel** keeps its row (order → acting Approver), and now reads `open_line_count`
  under the order lock: a receipt and a cancel serialize on the order.
- **Locks first, then checks**: every lock is taken in the order above before any
  check that needs one is evaluated; the checks below are then evaluated in the same
  precedence on the locked rows. The codes and outcomes are unchanged; no path locks
  the caller's `users` row before the lines.
- **Check order** (ADR-0004 precedence):
  1. `401`; `403 NO_ROLE_ASSIGNED`; `403 FORBIDDEN` by role, before validation and before
     any lookup (pure Approver: "Approvers can review orders but not change them.";
     Admin: "Admins can view orders but not change them.")
  2. `400` shape: strict body; `Idempotency-Key` (`REQUIRED`/`INVALID_FORMAT`); 1–500
     lines; the same line twice → `DUPLICATE_LINE_ID` on the later entry's `lineId`;
     quantity a whole number 1–1,000,000 (`INVALID_FORMAT` for a non-integer,
     `OUT_OF_RANGE` for 0, negative or above the maximum, as for line quantities); note; `receivedOn` a date not after today in
     India time (`DATE_IN_FUTURE`, injected clock)
  3. key claim: replay → the stored response; another body → `409 IDEMPOTENCY_KEY_REUSED`
  4. take the locks (order → lines → the caller's row, above); the order unreadable →
     `404`; readable, not the owner (a Buyer+Approver on a non-draft) →
     `403 NOT_ORDER_OWNER`
  5. the caller's locked row: deactivated → `401 ACCOUNT_DEACTIVATED`; BUYER removed →
     `403 FORBIDDEN`
  6. not `APPROVED` → `409 ORDER_NOT_RECEIVABLE` (`orderState.status`)
  7. a line id not on this order → `400 LINE_NOT_FOUND` (after the lock: which lines
     exist is order data)
  8. `receivedOn` before the approval date in India time → `400 DATE_BEFORE_APPROVAL`
  9. on the locked lines, over-receipt → `409 RECEIPT_EXCEEDS_OUTSTANDING`, listing every
     offending line in position order, each with its outstanding and the quantity asked
     (owner sign-off 2026-11-24)
  10. write (R6)
- Steps 7 and 8 are `400`s after a `409`: they need the locked order, so they can't come
  before it; a draft or pending order has no approval date to compare.

## R6 Set-based writes [steer, from clarify]

- **Decision**: per command, whatever its line count:
  - **one** statement for the receipt: a CTE inserting the `goods_receipts` row and, from
    its `RETURNING`, the `goods_receipt_lines` rows `SELECT … FROM unnest($lineIds,
    $quantities)`, returning the receipt's id and `recorded_at`;
  - one `INSERT INTO audit_entries … SELECT … FROM unnest(…)` for the
    `GOODS_RECEIPT_RECORDED` entries (a new `writeAuditBatch`, beside `writeAudit`);
  - before and after quantities come from the lines read under lock, so no read-back;
  - the response's `receiptProgress` is computed, not read back: `FULLY_RECEIVED` if the
    order's `open_line_count` read under the order lock minus the lines this receipt
    completes is 0, else `PARTIALLY_RECEIVED` (any receipt makes it at least partial).
- **Statements per command**: key claim, order lock, line lock and read, user lock,
  receipt insert (header and lines, one CTE), audit insert, key completion: 7, for 1 line or 500. A query-count
  test pins it.
- The triggers add one line update and one open-line recompute per command (R2, R3).

## R7 API

- `POST /api/orders/:id/receipts`, `Idempotency-Key` required, no `If-Match`; body
  `{ receivedOn: 'YYYY-MM-DD', note?: string | null, lines: [{ lineId, quantity }] }`
  (strict). `201` with the receipt: `{ id, receivedOn, recordedAt, note, lines: [{
  lineId, position, quantity, receivedBefore, receivedAfter, outstandingAfter }],
  receiptProgress }`. This is the response the key stores.
- `GET /api/orders/:id/receipts?page&pageSize`: readable by whoever can read the order
  (`404` otherwise): a page of receipts, newest recorded first (`recorded_at DESC, id
  DESC`, stable), each `{ id, receivedOn, recordedAt, recordedBy: { id, name }, note,
  lines: [{ line: { id, position, description }, quantity }] }` with all its lines in
  position order. The page and its `COUNT` cut receipts, never lines; the page's lines
  come from one more query by receipt id (the lines' primary key).
- Order read: each line gains `receivedQuantity`, `outstandingQuantity`; the order gains
  `receiptProgress` (`NOT_RECEIVED | PARTIALLY_RECEIVED | FULLY_RECEIVED`, ADR-0001's
  names) and `receivedLines: { complete, partly, total }`. List rows gain
  `receiptProgress`.
- Admin user detail and the admin update response gain `openOrders: { draft, pending,
  approvedWithOpenLines }`.
- Idempotency: `recordReceipt` joins `IDEMPOTENT_OPERATIONS` and the table's CHECK; the
  request hash covers the order id and the body, so the same key on another order is
  `IDEMPOTENCY_KEY_REUSED`.
- Contract change: new operations, new response fields, three registry codes going live.
  The two new field codes are new values of the `FieldCode` enum in error responses, so
  the `breaking` check is expected to flag them and need the label, as cancel's codes did
  in slice 5 (owner, 2026-11-24).

## R8 Receipt progress and the received summary

- `receiptProgress` = `FULLY_RECEIVED` when `open_line_count = 0` (orders always have
  lines, so a draft never qualifies; only approved or cancelled orders can have receipts,
  and a cancelled one can't be fully received); else `PARTIALLY_RECEIVED` when the order
  has any receipt; else `NOT_RECEIVED`.
- `receivedLines` on the order read: counted over its lines (already read for the page).
- Text, one helper in the web app: "2 of 5 lines complete, 1 partly received"; a zero
  part left out; "Nothing received" when both are zero. Badges: approved "Partly
  received" / "Fully received"; cancelled with receipts "Cancelled · partly received".

## R9 Lists: the badge without a stored counter [steer]

- Each page row (at most 50) adds `open_line_count`, and `receiptProgress` is computed
  per row: `CASE WHEN status NOT IN ('APPROVED','CANCELLED') THEN 'NOT_RECEIVED' WHEN
  open_line_count = 0 THEN 'FULLY_RECEIVED' WHEN EXISTS (SELECT 1 FROM goods_receipts r
  WHERE r.order_id = p.id) THEN 'PARTIALLY_RECEIVED' ELSE 'NOT_RECEIVED' END`; at most one
  index probe per row, after the page is cut.
- Proof: every page-1 list plan, for each scope (buyer, buyer+approver, approver, admin)
  and filter already committed, is re-committed with the per-row probe and must still
  stop at its page. Counts are unchanged (the badge isn't in them). If a plan fails, the
  owner sees it before any stored counter is added.

## R10 Indexes (shown for sign-off before adding)

| Index | Serves |
|---|---|
| `goods_receipts (order_id, recorded_at DESC, id DESC)` | the receipt history page and its `COUNT` (R7), and the list badge's EXISTS (R9); both history plans committed |
| `goods_receipts UNIQUE (id, order_id)` | the target of the lines' receipt key (R1) |
| `goods_receipts (recorded_by)` | the foreign key to `users` (as `cancelled_by`, slice 5) |
| `goods_receipt_lines (line_id)` | INV-3 in reconciliation, the line key's checks; the primary key `(receipt_id, line_id)` serves the history's lines |
| `order_lines UNIQUE (id, order_id)` | the target of R1's composite foreign key |

No index for the Admin's open-order counts: they read `(owner_id, status, created_at)`,
which exists; a plan test at the busiest Buyer proves it.

## R11 Races tested (each 10 times, barriers, business outcome asserted)

1. 50 single-unit receipts on a line with 30 outstanding: exactly 30 recorded, 20 `409
   RECEIPT_EXCEEDS_OUTSTANDING`, received = ordered, 30 receipts and 30 audit entries.
2. Two multi-line commands over overlapping lines: both fit → both recorded; only one
   fits → one recorded in full, the other refused in full; no deadlock.
3. Receipts on different lines of one order: all recorded (they serialize on the order).
4. Cancel vs a receipt that fully receives, both start orders: cancelled and the receipt
   `409 ORDER_NOT_RECEIVABLE`, or received and the cancel `409 ORDER_FULLY_RECEIVED`.
5. Cancel vs a partial receipt, both start orders: both succeed with `PO_CANCELLED`'s
   received quantities including the receipt, or the receipt refused.
6. A receipt vs the owner's deactivation or BUYER removal, both start orders: recorded
   before the change, or `401`/`403` after it; never recorded after it; no deadlock.
7. The same `Idempotency-Key` twice at once: one recorded, the other replays it.
8. A receipt vs the vendor's deactivation: both succeed.

## R12 Web app

- **Order page**: line table gains Received and Outstanding; a progress badge by the
  status; a Receipts section (history, paginated); "Record receipt" for the owner of an
  approved order with something outstanding.
- **Record receipt**: a form over the lines with outstanding quantities (quantity per
  line, blank = not in this delivery), the receipt date (default today in India time,
  min the approval date, max today), a note. Confirm opens the dialog (ADR-0018): per
  line "receiving N, received so far R, outstanding after M", the fully-received warning
  per line, safe button focused, one request on a double click, server errors inside
  with Reload order. One `Idempotency-Key` per opened dialog, reused on retry.
- **Cancel dialog**: per line ordered and received; the summary (R8). Cancel is not
  offered on a fully received order, nor the owner-can't-act marker.
- **Lists**: the badge (R8) in every order list and the approval queue rows left as they
  are (pending orders have nothing received).
- **Admin**: the API's user detail carries the three counts. The web app has no user
  detail page and gains none: the change-role and deactivate dialogs load the detail when
  opened and show the counts, and, when any is above zero, "An Approver rejects their pending
  orders and cancels their approved ones; a buyer raises new orders if still needed."
- **Demo seed**: per demo Buyer, one partly and one fully received approved order, and
  the cancelled order partly received, all through the receipt service (README's reset
  note covers it; no `.env` change).

## R13 Sign-off (signed off by the owner 2026-11-24, items 3 and 5 changed as above)

1. **ADR-0006 receipt lock row**: key → order → lines (id asc) → caller's `users` row
   `FOR SHARE` (R5), the caller re-checked under lock.
2. **New database rules D12–D17** and SQLSTATEs `PO020`–`PO025`; **D10 extended** to
   refuse cancelling a fully received order (`PO019`); the `received_quantity` guard
   (`PO005`) (R2, R4). Recorded in ADR-0001 and ADR-0003.
3. **"Not after today"** exact in the service; the database's loose backstop D17
   (`PO025`, India date + 1 day) (R4).
4. **Check order** for receipts, with `LINE_NOT_FOUND` and `DATE_BEFORE_APPROVAL` after
   the state `409` (R5); ADR-0004's precedence note.
5. **Two new field codes**: `DATE_IN_FUTURE`, `DATE_BEFORE_APPROVAL` (ADR-0007); the
   three registry codes go live with their details: `RECEIPT_EXCEEDS_OUTSTANDING` lists
   every offending line (`lineId`, `position`, `outstanding`, `requested`); `ORDER_NOT_RECEIVABLE` carries
   `orderState.status`; `ORDER_FULLY_RECEIVED` has no extra field.
6. **The indexes** (R10; reworked with the receipt document 2026-11-25).
7. **Plan fixture receipt mix** (ADR-0012): of the 89,000 approved orders, 45,000 fully
   received, 25,000 partly, 19,000 nothing; of the 1,000 cancelled, 500 partly received
   and 500 nothing; 1–3 receipts per received order, about 1.5M receipt lines in all,
   matching ADR-0012's volume.
8. **Payloads**: `GOODS_RECEIPT_RECORDED`, one per receipt line, details `{ receiptId,
   lineId, position, quantity, receivedBefore, receivedAfter, outstandingAfter,
   receivedOn, recordedAt, note }`, `receiptId` the receipt's (shared by its lines), actor `USER` acting as `BUYER` (ADR-0016); `openOrders` field names (R7).
9. **Admin dialog sentence** for open orders, and the counts shown in the two dialogs
   (loaded on open) rather than on a new user detail page (R12).
