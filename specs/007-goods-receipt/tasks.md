---

description: "Task list for Slice 6 — Goods receipt and concurrency"
---

# Tasks: Slice 6 — Goods receipt and concurrency

**Input**: Design documents from `specs/007-goods-receipt/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Required (Principle VIII). Every test task is **run and seen failing against
real PostgreSQL** (Testcontainers) before the task that makes it pass; its commit body
carries a "Failing run:" line under 100 characters. Requirement IDs go in test names only
(ADR-0013). Never weaken, skip or delete a test to pass.

**Order rule** (as slices 3–5): migration `0016_receipts` part 1, the database rules and
the raw-SQL attacks (Phase 3) are done and green **before any receipt service,
repository or route code** (first in Phase 4, T020). The trigger and attack tests are
seen failing on part 1 (table, grants, keys, indexes) before part 2 (triggers, guard,
D10's branch, the split recompute, INV-3).

**Operations per story**: Foundational adds constants, schemas, codes and the audit
event, but no operation. US1 adds `recordReceipt`, `listOrderReceipts` and `getOrderReceipt` to `OPERATIONS`
with their routes, and grows the OpenAPI operation list, the body inventory, the route
table and the authorization-matrix pins in the same commit.

**Organization**: Setup, Foundational, Database rules, then US1 → US2 → US3 → US4 → US5 →
list badge → US6 (plan order), then Polish. Stories run in sequence; each ends with a
checkpoint (green CI on the slice's draft PR) and a short summary stop.

## Format: `- [ ] T### [P?] [US#?] Outcome — files — refs`

- **[P]**: parallel with the other [P] tasks of the same group (different files, no
  dependency on an incomplete task).
- **Refs**: spec FR/SC, research R#, ADR, and the `docs/traceability.md` row ID the tests
  carry.
- **Size**: one reviewable commit each, roughly under 300 changed lines.
- **Layering**: `routes.ts` → `service.ts` → `repository.ts`; routes never import Prisma,
  a repository or `db/transaction.ts`.
- **While working**: run only the affected tests; the full gate
  (`set -o pipefail; npm test 2>&1 | tail -40`) and `npm run e2e:local` before each push.
- No hook bypass (no `LEFTHOOK_EXCLUDE`, no `--no-verify`): a test-first commit that
  imports code not yet written stubs the export so lint passes, and the test still fails
  on behaviour.
- No `.env*` change in this slice; if one turns out to be needed, stop and ask the owner.

---

## Phase 1: Setup

- [X] T001 Commit the spec, plan, research, data model, contracts, quickstart, tasks and
  the ADR updates (0001, 0003, 0004, 0006, 0007, 0012, 0016, owner sign-off 2026-11-24);
  draft PR for `007-goods-receipt` against `main`, body linking them, noting the
  `breaking` label is not needed (new field and error codes are extensible enums,
  ADR-0008; corrected 2026-11-25); no dependency change —
  GitHub.

---

## Phase 2: Foundational (blocks every story)

### Schema: migration `0016_receipts`, part 1 (table, grants, keys, indexes)

- [X] T002 Migration tests, seen failing (reworked 2026-11-25 for the receipt document,
  research R1): as [data-model.md](data-model.md), each rule by name:
  - `goods_receipts` with `id uuid` PK default `gen_random_uuid()`, `order_id` FK
    `purchase_orders`, "`received_on date` NOT NULL", `recorded_at timestamptz` NOT NULL,
    `recorded_by uuid` NOT NULL FK `users`, "`note text` NULL CHECK trimmed plain text,
    1–500 characters (the reason rule's character set); absent is `NULL`";
    `goods_receipts_id_order_key UNIQUE (id, order_id)`
  - `goods_receipt_lines` with `receipt_id`, `order_id`, `line_id`, "`quantity integer`
    NOT NULL CHECK `quantity BETWEEN 1 AND 1000000`", PK `(receipt_id, line_id)` (the same
    line twice in one receipt → `23505`)
  - FK `(receipt_id, order_id)` → `goods_receipts (id, order_id)` and FK `(line_id,
    order_id)` → `order_lines (id, order_id)`, both `ON DELETE RESTRICT`; a receipt line
    on another order's receipt or line → `23503`; "`order_lines_id_order_key UNIQUE (id,
    order_id)`"
  - indexes "`goods_receipts_order_recorded_idx (order_id, recorded_at DESC, id DESC)`",
    "`goods_receipts_recorded_by_idx (recorded_by)`", "`goods_receipt_lines_line_idx
    (line_id)`"
  - grants: `po_app` `SELECT` on both, "`INSERT (order_id, received_on, recorded_by,
    note)`" on `goods_receipts` and "`INSERT (receipt_id, order_id, line_id, quantity)`"
    on `goods_receipt_lines` only; no `UPDATE`, `DELETE`, `TRUNCATE`
  - `require_actor_context` on both tables; the `idempotency_keys` operation CHECK accepts
    `recordReceipt`
  — `backend/tests/integration/migrations.test.ts`, `receipt-schema.test.ts` (new) —
  data-model.md, R1, R10.
- [X] T003 Migration `0016_receipts` part 1: both tables, checks, keys, indexes, grants,
  actor triggers, CHECK widened; Prisma models (`GoodsReceipt`, `GoodsReceiptLine`;
  read-only `received_quantity` unchanged)
  — `backend/prisma/migrations/0016_receipts/migration.sql`, `backend/prisma/schema.prisma`
  — R1, R10; T002 green.
- [X] T004 [P] Constants pinned, seen failing first: `RECEIPT_PROGRESS = ['NOT_RECEIVED',
  'PARTIALLY_RECEIVED', 'FULLY_RECEIVED']`; `RECEIPT_QUANTITY_MIN = 1`,
  `RECEIPT_QUANTITY_MAX = LINE_QUANTITY_MAX` (imported); `RECEIPT_NOTE_MAX = 500` (pinned to
  the `goods_receipts` note CHECK; the quantity limits to the `goods_receipt_lines` CHECK); `RECEIPT_TIME_ZONE = 'Asia/Kolkata'`;
  `IDEMPOTENT_OPERATIONS` gains `recordReceipt` (pinned to the table CHECK) —
  `packages/contracts/src/receipts.ts` (new), `backend/src/idempotency/repository.ts`,
  `backend/tests/integration/order-constants.test.ts`, `idempotency.test.ts` — R7,
  contracts/api.md.

### Contracts

- [X] T005 [P] Schemas, seen failing first: `recordReceiptBody` (strict; `receivedOn`
  `YYYY-MM-DD`; `note` plain text 0–500, nullable, optional; `lines` 1–500 of strict
  `{ lineId: uuid, quantity }` with quantity "a whole number 1–1,000,000"
  (`INVALID_FORMAT` non-integer, `OUT_OF_RANGE` 0/negative/above); the same `lineId` twice
  → `DUPLICATE_LINE_ID` at `body.lines.{i}.lineId` of the later entry); `recordedReceipt`
  (the receipt: `id`, `receivedOn`, `recordedAt`, `note`, `receiptProgress`, `lines`);
  `receiptSummary` (a receipt with `lineCount`); `receiptPage`; `receiptDetail` (a receipt
  with its lines, ≤ 500, position order); every new response field read-only in request
  bodies (`READ_ONLY_FIELD`; `RECEIPT_READ_ONLY_FIELDS`, `ORDER_READ_ONLY_FIELDS` +=
  `receiptProgress`). The new required response fields on `orderLine`,
  `order`, `orderListItem` and `adminUserDetail` land with the reads that produce them
  (T020, T034, T038): every response is checked against the committed OpenAPI document,
  so adding them here would fail every order and admin response until then — `packages/contracts/src/schemas/receipts.ts` (new), `orders.ts`,
  `admin-users.ts`, `read-only.ts`, `packages/contracts/tests/receipt-schemas.test.ts`
  (new), `order-schemas.test.ts` — contracts/api.md, NFR-VAL-01.
- [X] T006 [P] Error codes and details, seen failing first: `FIELD_CODES` gains
  `DATE_IN_FUTURE`, `DATE_BEFORE_APPROVAL`; `ORDER_NOT_RECEIVABLE` carries `orderState: {
  status }`; `RECEIPT_EXCEEDS_OUTSTANDING` carries `lines: [{ lineId, position,
  outstanding, requested }]` (every offending line, position order);
  `ORDER_FULLY_RECEIVED` no member; the receipt `FORBIDDEN` details, Approver "Approvers
  can't record receipts. The order's Buyer records them." (owner, 2026-11-25), Admin the
  order-write one; new field and error codes are non-breaking (`x-extensible-enum`, no
  label) — `packages/contracts/src/errors.ts`,
  `schemas/problem.ts`, `orders.ts`, `packages/contracts/tests/errors.test.ts` —
  contracts/errors.md, ADR-0007 2026-11-24.
- [X] T007 [P] Database errors `PO020`–`PO025` (`ORDER_NOT_RECEIVABLE`,
  `RECEIPT_NOT_BY_OWNER`, `RECEIPT_EXCEEDS_ORDERED`, `RECEIPT_IMMUTABLE`,
  `RECEIPT_BEFORE_APPROVAL`, `RECEIPT_DATE_TOO_LATE`) → `INTERNAL_ERROR` with their names,
  unit test first — `backend/src/db/errors.ts`, `backend/tests/unit/db-errors.test.ts` —
  R4, data-model.md.
- [X] T008 [P] Audit: event `GOODS_RECEIPT_RECORDED`, one per receipt line (actor `USER`
  acting as `BUYER`; details `{ receiptId, lineId, position, quantity, receivedBefore,
  receivedAfter, outstandingAfter, receivedOn, recordedAt, note }`, `receiptId` the
  receipt's id on every entry of one receipt); `ORDER_AUDIT_ACTIONS` extended;
  `writeAuditBatch(tx, events)` as one `INSERT … SELECT FROM unnest(…)`, unit and
  integration tests first (one statement for 1 or 500 entries; on a multi-line receipt
  every row carries the actor's name and email, the capacity (`acting_role` `BUYER`) and
  the request id) — `backend/src/audit/events.ts`, `write.ts`,
  `packages/contracts/src/orders.ts`, `backend/tests/unit/audit-write.test.ts`,
  `backend/tests/integration/audit-batch.test.ts` (new); the timeline names the event
  "Goods received" — R6, ADR-0016 2026-11-24, NFR-AUD-01.
- [X] T009 [P] Web messages and helper, tests first: messages for `ORDER_NOT_RECEIVABLE`
  ("This order can't receive goods: it is {status}."), `RECEIPT_EXCEEDS_OUTSTANDING`
  ("Nothing was recorded." + one line per offending line), `ORDER_FULLY_RECEIVED`,
  `DATE_IN_FUTURE`, `DATE_BEFORE_APPROVAL ({date})`; `receipt-progress.ts`: the summary
  ("2 of 5 lines complete, 1 partly received", a zero part left out, "Nothing received"),
  badges ("Partly received", "Fully received", "Cancelled · partly received"), the
  fully-received warning, the admin open-orders sentence — `frontend/src/errors/messages.ts`,
  `frontend/src/pages/orders/receipt-progress.ts` (new),
  `frontend/tests/error-messages.test.ts`, `receipt-progress.test.ts` (new) —
  contracts/errors.md, R8.

**Checkpoint**: migration part 1 applied; contracts build; gate green.

---

## Phase 3: Database rules first (base of US3 and US4)

**Goal**: no path, raw SQL included, over-receives, receives on a non-approved order,
receives as someone else, writes `received_quantity`, or changes a receipt.
**Independent test**: the attacks below, each refused, then reconciliation zero rows.

- [X] T010 [P] Trigger tests, seen failing on part 1 (reworked 2026-11-25): as `po_app`
  with an actor context, inserting a receipt with its lines in one statement: on a
  draft, pending, rejected, cancelled order → `PO020`; `recorded_by` ≠ owner, or ≠ the
  actor, or actor `SYSTEM` → `PO021`; `received_on` the day before approval (IST) →
  `PO024`, the approval day allowed; `received_on` the database's IST date + 2 → `PO025`,
  + 1 allowed; one line over ordered, two receipts in one statement on one line summing
  over, one multi-line receipt with one bad line → `PO022` and nothing written; a
  receipt with no line → `23514`; a line for a receipt that already has lines from another statement (a
  second statement in the same transaction, a later transaction) →
  `PO023` (as `po_app` and `po_owner`); `recorded_at` sent → replaced by `now()`; an
  allowed receipt sets `received_quantity` and `open_line_count`, leaves `version` and
  `total`; `UPDATE`/`DELETE`/`TRUNCATE` of either table → `PO023` (as `po_owner`;
  `po_app` has no privilege); the SQL time-zone literals in D14 and D17 pinned to
  `RECEIPT_TIME_ZONE` — `backend/tests/integration/receipt-triggers.test.ts` (new) —
  D12–D17, FR-004, FR-010, FR-RCV-02, FR-SM-01.
- [X] T011 [P] Attack suite, seen failing: as `po_app` and as a privileged role (loud
  error, never a silent fix): `UPDATE order_lines SET received_quantity`, an
  `order_lines` insert with non-zero received → `PO005` (or a privilege error first for
  `po_app`); `UPDATE purchase_orders SET open_line_count` → `PO005`; the T010 receipt
  attacks; cancelling a fully received order by SQL → `PO019`; every attack ends in
  reconciliation zero rows, INV-3 included; a planted drift (owner role, flag forged)
  is caught by INV-3 — `backend/tests/integrity/receipt-attacks.test.ts` (new),
  `reconciliation.test.ts` — FR-024, SC-003, FR-PO-03, FR-RCV-02.
- [X] T012 [P] Trigger efficiency, seen failing: a 1-line and a 500-line receipt run
  `recompute_orders` 0 times and `recompute_open_lines` once
  (`po.open_line_recompute_count`); an order edit's counts unchanged —
  `backend/tests/integrity/trigger-count.test.ts` — R3, FR-009, NFR-PERF-03.
- [X] T013 Migration part 2 (reworked 2026-11-25): `goods_receipts_before_insert`
  (`recorded_at := now()`); `goods_receipts_after_insert` (statement, `new_receipts`: a
  receipt with no line → `23514`); `goods_receipt_lines_after_insert` (statement,
  `new_lines`; orders then lines locked in id order before any check; D16 for a line on
  a receipt that already has lines outside this statement, D12, D13, D14, D17 read through each line's receipt,
  D15 on the sums naming the first line by position; flag `po.receipts`; one set-based
  `UPDATE order_lines`); `receipts_immutable` (D16) on both tables;
  `order_lines_received_guard` (`PO005`); `recompute_open_lines(uuid[])` and
  `order_lines_after_update` calling it when only `received_quantity` changed;
  `purchase_orders_cancel_guard` D10 branch (`OLD.open_line_count = 0` → `PO019`); all
  `SECURITY DEFINER`/`INVOKER` as data-model.md, pinned `search_path`, `REVOKE … FROM
  PUBLIC`; INV-3 over `goods_receipt_lines` in `reconciliation.sql`; T010–T012 green —
  `backend/prisma/migrations/0016_receipts/migration.sql`,
  `backend/src/db/reconciliation.sql` — R2–R4, data-model.md.
- [X] T014 State machine, database side: receipt refused per non-approved state;
  T10 refused on a fully received order, allowed with part received — one test each —
  `backend/tests/integration/order-triggers.test.ts` — FR-010, FR-016, FR-SM-01.
- [X] T015 [P] Property test: random sequences of receipts (single and multi-line, a line
  once per receipt, some over) against random orders; after each, `received_quantity = Σ
  receipt lines`, `0 ≤ received ≤ quantity`, `open_line_count` = lines with received <
  ordered; reconciliation zero rows —
  `backend/tests/integrity/receipt-invariants.property.test.ts` (new) — INV-3, INV-4,
  INV-6, FR-003, FR-008, FR-RPT-03.

**Checkpoint**: no path, API or raw SQL, breaks INV-3/INV-4/INV-6 or changes a receipt.

---

## Phase 4: User Story 1 — Partial receipts across several deliveries (P1) 🎯 MVP

**Goal**: the owner records 40 then 60 on a line; quantities, progress and history
follow. **Independent test**: spec US1's independent test.

- [X] T016 [US1] Receipt service tests, seen failing: owner on an approved one-line order
  of 100 records 40 (date today IST, injected clock) → `201` `recordedReceipt` (one receipt,
  its line with before 0, after 40, outstanding 60; progress `PARTIALLY_RECEIVED`); then 60 →
  100/0, `FULLY_RECEIVED`, status still `APPROVED`; `version` unchanged, no `If-Match`
  needed; one `GOODS_RECEIPT_RECORDED` each with both dates; a receipt dated the approval
  day accepted; at 00:30 IST dated today (IST) accepted; tomorrow IST → `400
  DATE_IN_FUTURE`; before approval → `400 DATE_BEFORE_APPROVAL`; vendor inactive →
  recorded — `backend/tests/integration/receipts-record.test.ts` (new) — FR-001, FR-006,
  FR-007, FR-013, FR-RCV-01, FR-VEN-02, NFR-AUD-01.
- [X] T017 [US1] Idempotency tests, seen failing: no key → `400` `REQUIRED` at
  `header.idempotency-key`; bad key `INVALID_FORMAT`; same key and body → the stored
  response, one receipt; same key, other body or other order → `409
  IDEMPOTENCY_KEY_REUSED` — `backend/tests/integration/receipts-record.test.ts` — FR-007,
  NFR-CON-03.
- [X] T018 [US1] Receipt repository and service: lock order idempotency key → order
  `FOR UPDATE` → the command's lines (id asc) `FOR UPDATE` → the caller's `users` row
  `FOR SHARE` (ADR-0006's receipt row), all taken before the checks, which then run in
  research R5's order on the locked rows (R5 "Locks first, then checks"); the response's
  `receiptProgress` computed from `open_line_count` read under the order lock minus the
  lines this receipt completes, no read-back (R6); one statement for the receipt and its
  lines (a CTE: the `goods_receipts` insert, then `goods_receipt_lines … FROM unnest`,
  `RETURNING` the receipt's id and `recorded_at`), one `writeAuditBatch` (each entry
  carrying the receipt's id); the key completed with the
  response; clock injected — `backend/src/receipts/service.ts`, `repository.ts` (new) —
  R5, R6, ADR-0006 2026-11-24.
- [X] T019 [US1] Routes and operations: `recordReceipt` (`POST /api/orders/{id}/receipts`,
  role BUYER, Approver and Admin `FORBIDDEN` details, `Idempotency-Key` required, CSRF,
  `201`); `listOrderReceipts` (`GET`, receipt summaries with `lineCount`, paginated
  `recorded_at DESC, id DESC`, `404` when the order is unreadable); `getOrderReceipt`
  (`GET …/receipts/{receiptId}`, the receipt's lines in position order, `404` when the
  order is unreadable or the receipt isn't on it); OpenAPI regenerated; route table, CSRF, body inventory,
  matrix pins — `packages/contracts/src/operations.ts`, `backend/src/receipts/routes.ts`
  (new), `backend/src/api.ts`, `backend/tests/integration/route-table.test.ts`,
  `packages/contracts/tests/openapi.test.ts`, `body-inventory.test.ts` — contracts/api.md;
  T016, T017 green.
- [X] T020 [US1] Order read and history, tests first: the schemas and reads together:
  `orderLine` += `receivedQuantity`, `outstandingQuantity`; `order` += `receiptProgress`
  (from T005; no `receivedLines`: the web app counts from the lines, owner 2026-11-25);
  the receipts page
  (summaries with `lineCount`; stable sort, equal `recorded_at` ordered by id, page
  boundaries) and one receipt's lines (position order; a 500-line receipt; another
  order's receipt id `404`) for owner, Approver, Admin; other Buyer `404` on both; the timeline shows both dates —
  `backend/src/orders/repository.ts`, `backend/src/receipts/repository.ts`,
  `backend/tests/integration/orders-read.test.ts`, `receipts-history.test.ts` (new),
  `orders-timeline.test.ts` — FR-005, FR-021, FR-RCV-03, R7, R8.
- [X] T021 [P] [US1] Order detail, component tests first: Ordered, Received, Outstanding
  columns on non-draft orders; the progress badge by the status; `ReceiptsSection`
  (per receipt summary: receipt date, recorded by, recorded at, note, "N lines"; newest
  first; paginated; expanding a receipt loads its lines, with loading and error states;
  "No goods received yet."); the "Record receipt" button lands with the form it opens
  (T025): shown only to the owner of an `APPROVED` order not fully received; axe — `frontend/src/pages/orders/OrderDetail.tsx`,
  `ReceiptsSection.tsx` (new), `queries.ts`, `frontend/tests/order-receipts-detail.test.tsx`
  (new) — FR-021, contracts/ui.md, NFR-FE-08.

**Checkpoint**: the owner records a partial then a full receipt through the API; the page
shows quantities, progress and history.

---

## Phase 5: User Story 2 — Several lines at once, all or nothing (P1)

- [X] T022 [US2] Tests, seen failing: lines A 10, B 5, C 8 outstanding: A 10, B 6, C 8 →
  `409 RECEIPT_EXCEEDS_OUTSTANDING` with `lines` = [B] (outstanding 5, requested 6), no
  receipt, no audit entry, no line changed; A 11, B 6 → both listed in position order; A
  10, B 5, C 3 → one receipt with 3 lines, 3 entries sharing its id, date and note; a fully received line and
  any quantity → `409` naming it; quantity 0, −1, 1.5, 1,000,001; a line of another
  order (one the caller owns too) → `LINE_NOT_FOUND`; the same line twice →
  `DUPLICATE_LINE_ID` on the later entry; `lines: []` `TOO_SHORT`; 501 lines `TOO_LONG`;
  note 501 `TOO_LONG`; unknown field `UNKNOWN_FIELD`; a read-only field `READ_ONLY_FIELD`;
  a 500-line receipt accepted — `backend/tests/integration/receipts-multiline.test.ts`
  (new) — FR-002, FR-RCV-01, FR-RCV-02, NFR-VAL-01.
- [X] T023 [US2] Query count, seen failing: one command runs 7 statements for 1 line and
  for 500 (key claim, order lock, line lock and read, user lock, receipt insert (header
  and lines, one CTE), audit insert, key completion) — `backend/tests/integration/receipts-query-count.test.ts` (new)
  — R6, NFR-PERF-03.
- [X] T024 [US2] Service: every offending line listed (not only the first); the set-based
  writes pinned by T023; T022, T023 green — `backend/src/receipts/service.ts`,
  `repository.ts` — R5 step 9, R6.
- [X] T025 [P] [US2] Record receipt form and dialog, component tests first: the "Record
  receipt" button (from T021), only for the owner of an `APPROVED` order not fully
  received; one row per
  line with outstanding > 0 (blank = not in this delivery, labelled per line); date
  (default today IST, `min` approval date, `max` today); note 0–500; Continue is a submit
  button, so Enter in a quantity submits; with every line blank, submit says "Enter a
  quantity for at least one line." tied to the lines (`aria-describedby`) and moves focus
  to the first line (owner, 2026-11-25); field errors inline by code; dialog per line "Line {n}: receiving {N},
  received so far {R}, outstanding after {M}" and the fully-received warning per line
  reaching 0; "Go back" focused; one request on a double click; one `Idempotency-Key` per
  opening reused on retry; `RECEIPT_EXCEEDS_OUTSTANDING` inside with every line and each
  input marked, Reload order; success reloads the order and receipts and announces
  "Receipt recorded."; axe — `frontend/src/pages/orders/ReceiptForm.tsx`,
  `ReceiptDialog.tsx` (new), `frontend/tests/receipt-form.test.tsx` (new: the form and
  the dialog, one file) — FR-019,
  contracts/ui.md, NFR-FE-09, SC-007.

---

## Phase 6: User Story 3 — Only the owner, only approved orders (P1)

- [X] T026 [US3] Matrix receipt row, tests first where new: owner → `201`; other Buyer →
  `404`; Buyer+Approver non-owner → `403 NOT_ORDER_OWNER`; pure Approver → `403
  FORBIDDEN` "Approvers can't record receipts. The order's Buyer records them." (owner,
  2026-11-25) also for an order that
  doesn't exist and with a bad body; Admin → `403 FORBIDDEN` (Admin detail); no role →
  `403 NO_ROLE_ASSIGNED`; anonymous `401`; × 5 states (owner on draft, pending, rejected,
  cancelled → `409 ORDER_NOT_RECEIVABLE` with `orderState.status`); the receipts read row
  × callers; every refusal leaves lines, receipts and audit unchanged —
  `backend/tests/integration/authorization-matrix.test.ts`, `receipts-access.test.ts`
  (new) — FR-010, FR-011, FR-OWN-01, FR-APR-01, SC-002.
- [X] T027 [US3] Caller under lock: owner without BUYER → `403 FORBIDDEN`; deactivated →
  `401 ACCOUNT_DEACTIVATED`; restored → receives again; the same two changes made after
  the route check (the service called with the user as the route saw them) refused by
  the re-check under lock; check order as ADR-0004
  2026-11-24 (`LINE_NOT_FOUND` and `DATE_BEFORE_APPROVAL` after `ORDER_NOT_RECEIVABLE`) —
  `backend/tests/integration/receipts-access.test.ts` — FR-012, FR-ACC-07, FR-ACT-01.
- [X] T028 [US3] `/security-review` of US3 (CLAUDE.md: permission stories): the route
  role check, the under-lock caller re-check, D13 in the database; fix findings tests
  first. The slice-end review (T045) stays. Ran 2026-11-25: no findings (route roles,
  404 for non-readers, receipt ids scoped to their order, idempotency per user and order,
  the re-check under lock, D13 in the database, parameterised SQL, SECURITY DEFINER
  search paths, po_app's column grants).

---

## Phase 7: User Story 4 — Simultaneous receipts never over-receive (P1)

- [X] T029 [US4] All eight races of research R11 (owner, 2026-11-25: races 4–5 too, so
  T032 is done here), each ordered on a lock held on the test's own connection and
  released once `pg_stat_activity` shows the requests waiting (never a sleep), both start
  orders where either can happen, no `40P01` (the transaction runner now logs every
  retry with its SQLSTATE) and reconciliation empty after each; race 6 reaches the
  re-check under lock (the change committed while the receipt waits on the users row,
  holding the order and lines), and removing that re-check fails it; the file passed 20
  runs in a row. Races, barriers, 10 runs each (race 1: 3 runs of 50 requests), business outcomes asserted (research R11
  1–3, 6–8), each asserting the lock order (no `users` row before an order or line): 50 single-unit receipts on a line with 30 outstanding (exactly 30 recorded,
  20 `409`, 30 receipts, 30 entries); overlapping multi-line commands (both fit → both;
  one fits → one in full, the other refused in full); receipts on different lines of one
  order (all recorded); a receipt vs the owner's deactivation and vs BUYER removal, each
  in either start order (recorded before, or `401`/`403` after, never after); the same
  `Idempotency-Key` twice at once (one recorded, the other replays); a receipt vs vendor
  deactivation (both succeed); no deadlock; reconciliation zero rows after each —
  `backend/tests/concurrency/receipts.test.ts` (new), `lock-order.test.ts` (the receipt
  row) — FR-014, FR-015, FR-RCV-04, NFR-CON-01, SC-001.

---

## Phase 8: User Story 5 — Cancelling an order with receipts (P2)

- [X] T030 [US5] Cancel tests (the check landed with T029's race 4, so mutation-checked): partly received → `200`, receipts kept,
  `PO_CANCELLED` lines carry each `receivedQuantity`; fully received → `409
  ORDER_FULLY_RECEIVED` (after the version check), nothing changes; a receipt after cancel
  → `409 ORDER_NOT_RECEIVABLE`, outstanding still `ordered − Σ receipts` —
  `backend/tests/integration/receipts-cancel.test.ts` (new) — FR-016, FR-017, FR-LCK-02.
- [X] T031 [US5] Cancel service (with T029's race 4 as its failing test): reads `open_line_count` under the order lock, refuses
  fully received; T030 green — `backend/src/approvals/service.ts`, `repository.ts` — R5,
  ADR-0001 T10.
- [X] T032 [US5] Races (research R11 4–5; done in T029, `tests/concurrency/receipts.test.ts`), 10 runs each start order: cancel vs a receipt
  that fully receives (cancelled + receipt `409 ORDER_NOT_RECEIVABLE`, or received + cancel
  `409 ORDER_FULLY_RECEIVED`); cancel vs a partial receipt (both, with the receipt in
  `PO_CANCELLED`, or the receipt refused); never a `PO_CANCELLED` disagreeing with the
  receipts; no deadlock — `backend/tests/concurrency/cancel.test.ts` — FR-018, SC-004,
  NFR-CON-01.
- [X] T033 [P] [US5] Cancel dialog and page, component tests first: per line ordered and
  received; the summary instead of "Nothing has been received against this order." when
  something was; `ORDER_FULLY_RECEIVED` inside with Reload order; no Cancel and no
  owner-can't-act marker on a fully received order; a cancelled page shows "Cancelled ·
  2 of 5 lines complete, 1 partly received" and per-line "60 of 100 received"; axe —
  `frontend/src/pages/orders/CancelDialog.tsx`, `CancellationSection.tsx`,
  `OrderDetail.tsx`, `frontend/tests/cancel-receipts.test.tsx` (new) — FR-020, NFR-FE-09.

---

## Phase 9: List badge (FR-021a)

- [X] T034 Lists, tests first: `orderListItem` += `receiptProgress` (schema, from T005)
  and every scope's rows carry it (approved
  nothing/partly/fully; cancelled with and without receipts; drafts, pending, rejected
  `NOT_RECEIVED`); counts unchanged; no new filter —
  `backend/src/orders/repository.ts` (`orderListSql`: the per-row `CASE … EXISTS` after
  the page is cut), `backend/tests/integration/orders-list.test.ts` — FR-021a, R9.
- [X] T035 [P] Plan fixture receipt mix (ADR-0012 2026-11-24): of 89,000 approved, 45,000
  fully, 25,000 partly, 19,000 nothing; of 1,000 cancelled, 500 partly, 500 nothing; 1–3
  receipts per received order (≈1.5M receipt lines), inserted set-based through the trigger, with
  matching audit entries; reconciliation on the fixture zero rows —
  `backend/tests/plans/orders-fixture.ts` — R13.7, NFR-PERF-01.
- [X] T036 Plans: every page-1 list plan (buyer, buyer+approver, approver, admin; each
  committed filter) re-committed with the probe and still stopping at its page; the
  receipt history page 1 plan (with the per-row `lineCount`) and its `COUNT` plan on the
  busiest order; one receipt's lines plan on a 500-line receipt. **If any plan fails, stop and show the
  owner before adding a stored counter or index** — `backend/tests/plans/orders.plan.test.ts`,
  `receipts.plan.test.ts` (new), `docs/query-plans/orders/` — FR-021a, R9, R10,
  NFR-PERF-01.
- [X] T037 [P] Web: every order list shows the badge after the status (text, not colour
  alone); the approval queue unchanged — `frontend/src/pages/orders/OrdersList.tsx`,
  `frontend/tests/orders-list.test.tsx` — FR-021a, NFR-FE-08.

---

## Phase 10: User Story 6 — The Admin sees open orders (P3)

- [X] T038 [US6] Tests, seen failing: the spec's Buyer (2 drafts, 1 pending, 3 approved of
  which 1 fully received, 1 rejected, 1 cancelled) → `openOrders { draft: 2, pending: 1,
  approvedWithOpenLines: 2 }` on `GET /api/admin/users/{id}` and on the update response
  (`adminUserDetail` += `openOrders`, schema from T005);
  a user with no orders, an Approver, an Admin → zeros —
  `backend/tests/integration/admin-users.test.ts`, `backend/src/admin-users/service.ts`,
  `repository.ts` — FR-023, FR-ADM-02.
- [ ] T039 [P] [US6] Count plan at the busiest Buyer on the fixture uses
  `(owner_id, status, created_at)`, no new index (if it fails, stop and show the owner) —
  `backend/tests/plans/orders.plan.test.ts`, `docs/query-plans/orders/` — R10,
  NFR-PERF-01.
- [X] T040 [P] [US6] Admin dialogs, component tests first: RoleDialog and ActivationDialog
  load the user detail on open (loading state, then "{draft} drafts · {pending} pending ·
  {approvedWithOpenLines} approved with goods to receive"), and when any is above zero
  "An Approver rejects their pending orders and cancels their approved ones; a buyer
  raises new orders if still needed."; a load error shown inside; axe —
  `frontend/src/pages/admin/RoleDialog.tsx`, `UserDialogs.tsx`, `queries.ts`,
  `frontend/tests/admin-users-page.test.tsx` — FR-023, ADR-0016 2026-11-24.

---

## Phase 11: Polish & cross-cutting

- [ ] T041 [P] Receipt timings on the plan fixture, 50 timed runs after 3 warm-up:
  single-line p95 ≤ 150 ms (`DECISION_P95_MS`), 500-line p95 ≤ 500 ms (`WRITE_P95_MS`) — `backend/tests/plans/orders.timing.test.ts` — SC-005, NFR-PERF-01.
- [ ] T042 [P] Demo seed: per demo Buyer one partly and one fully received approved order,
  and the cancelled order partly received (receipts before the cancel), all through the
  receipt service; idempotent on reseed; reconciliation zero rows; no `.env` change —
  `backend/src/migrate/seed-demo.ts`, `backend/tests/integration/seed-demo.test.ts` —
  spec Assumptions, R12.
- [ ] T043 E2E: create → submit → approve → partial receipt (dialog, warning absent) → a
  receipt fully receiving a line (fully-received wording) → badges in the list; the
  Approver's cancel dialog shows the summary; axe on the form, dialog and page —
  `frontend/e2e/receipts.spec.ts` (new) — FR-022, NFR-FE-07, NFR-FE-09, SC-006 (recorded
  as observed in this run and the quickstart walkthrough; no timed step), SC-007.
  Run `npm run e2e:local`.
- [ ] T044 Traceability: FR-RCV-01–04, FR-LCK-02, FR-SM-01, FR-OWN-01, FR-RPT-03 (the
  stored count), FR-PO-03 (the outstanding half), FR-ADM-02 (counts), NFR-AUD-01,
  NFR-CON-01, NFR-CON-03, NFR-PERF-01/03, NFR-FE-07/08/09 — each with its passing test,
  status as the slice leaves it (the report itself is slice 7); `npm run
  check:traceability` green — `docs/traceability.md`.
- [ ] T045 Quickstart run and results (SC-006 recorded as observed in the walkthrough of
  scenario 2's valid three-line command); slice-end review: `/code-review`,
  `/security-review` (permissions, the new triggers, the guard), constitution pass; fix
  findings; full gate, lint, typecheck green —
  `specs/007-goods-receipt/quickstart-results.md`.

---

## Owner requirements → tasks

| Requirement (2026-11-24) | Tasks |
|---|---|
| Lock order → lines (ADR-0006); DB refuses received > ordered on any insert path | T010, T011, T013, T018, T029 |
| Received quantity stored, statement trigger, guarded, in reconciliation | T010–T013, T015 |
| Set-based writes for receipts and their audit entries | T008, T013, T023, T024 |
| Full receipt leaves the status `APPROVED` (ADR-0001 unchanged) | T014, T016 |
| D17 loose date backstop; exact "not after today" in the service | T010, T016 |
| Every offending line listed | T006, T022, T024, T025 |
| Same line twice → 400; quantity whole number ≥ 1 | T005, T022 |
| New field and error codes non-breaking (extensible enums, no label) | T001, T006 |
| Pure Approver `403 FORBIDDEN` by role, before lookup | T019, T026 |
| Badge by per-row EXISTS; plans proved; stop if one fails | T034, T036 |
| 500-line p95 ≤ 500 ms; single-line 150 ms; 50 after 3 | T041 |
| Demo seed receipt states | T042 |

## Dependencies and execution order

- T001 → Foundational (T002–T009) → Database rules (T010–T015) → US1 (T016–T021) → US2
  (T022–T025) → US3 (T026–T028) → US4 (T029) → US5 (T030–T033) → Badge (T034–T037) →
  US6 (T038–T040) → Polish (T041–T045).
- Foundational: T002 → T003; T004–T009 in parallel after T003.
- Database rules: T010, T011, T012 seen failing on part 1 → T013; T014, T015 after T013.
- US1: T016, T017 → T018 → T019 → T020; T021 in parallel with T018–T020.
- US2: T022, T023 → T024; T025 in parallel.
- US5: T030 → T031 → T032; T033 in parallel.
- Badge: T034 and T035 → T036; T037 in parallel.
- T041, T042 in parallel (after T035); T043 → T044 → T045.

## Parallel examples

- Foundational: T004, T005, T006, T007, T008, T009 together.
- Database rules: T010, T011, T012 together; then T013.
- Badge: T035, T037 together.
- Polish: T041, T042 together.

## Implementation strategy

Database rules first (Phase 3): before any receipt code, no path can over-receive, receive
on a non-approved order or as someone else, or change a receipt. MVP is US1 (partial then
full receipt through the API and on the page). US2 adds the multi-line refusals and the
form, US3 the matrix row, US4 the races, US5 slice 5's deferrals, then the badge with its
plans and US6 the Admin counts. Each story: tests first, seen failing against real
PostgreSQL, then code; a short summary stop after each story.
