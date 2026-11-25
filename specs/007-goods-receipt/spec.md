# Feature Specification: Slice 6 — Goods receipt and concurrency

**Feature Branch**: `007-goods-receipt`

**Created**: 2026-11-23

**Status**: Draft

**Input**: User description: "Slice 6: per-line receipts, partial across several events,
multi-line all-or-nothing, over-receipt refused, 50 parallel receipts never exceed
ordered, receipts lock the order first (ADR-0006), plus what slice 5 deferred:
ORDER_FULLY_RECEIVED on cancel, 'partly received' in the cancel dialog, the
cancel-vs-receipt race, and Admin open-order counts."

## Context

Slice 5 closed the order lifecycle: an approved order is locked, and an Approver may
cancel it. What an approved order is *for* is still missing: recording the goods that
arrive. The brief asks for receipts per line, partial, across several separate events,
with outstanding quantity always equal to ordered minus the sum of receipts and a
receipt that would exceed the ordered quantity refused (brief §3.6), and it asks for that
guarantee to hold when two receipts for the same line arrive at almost the same instant
(brief §8).

Receipts are recorded by the order's owner only (ADR-0004), against `APPROVED` orders only
(ADR-0001). A receipt is not a state transition: the order stays `APPROVED`, and its
receipt progress (nothing, partly, fully received) is derived from its lines, never stored
(ADR-0001). Receipts are append-only and can't be corrected (ADR-0011, ADR-0019), so the
receipt dialog shows exactly what each line will look like afterwards.

The users are:
- a **Buyer**, who records what arrived against their own approved orders, in one or
  several deliveries, one or several lines at a time
- an **Approver**, who sees receipt progress on any approved order and can no longer
  cancel one that is fully received
- a **Procurement Admin**, who sees receipt progress read-only, and sees how many open
  orders a user has before changing their roles or deactivating them

**Carried over from slice 5** (ADR-0011, ADR-0018, ADR-0019):
- a fully received order can't be cancelled (`409 ORDER_FULLY_RECEIVED`)
- the cancel dialog summarises what was received ("2 of 5 lines complete, 1 partly
  received"), not only "nothing received"
- the cancel-versus-receipt race ends in one consistent outcome
- the Admin's user detail and the change-role and deactivate dialogs show the user's
  open-order counts (draft, pending, approved with open lines)

Out of scope: the outstanding-orders report and its query plans (slice 7, ADR-0015);
receipt corrections or reversals (not adopted, ADR-0019); close-short of a partly received
order other than by cancelling it; notifications (ADR-0019).

## Clarifications

### Session 2026-11-24

- Q: What does a pure Approver get when they record a receipt? → A: `403 FORBIDDEN`
  "Approvers can review orders but not change them." at route level, before the order is
  looked up, so nothing about the order leaks; ADR-0004's receipt cell amended. A
  Buyer+Approver who isn't the owner still gets `403 NOT_ORDER_OWNER` (asked during
  `/speckit-specify`).
- Q: Which lines does the received summary count? → A: Both: "2 of 5 lines complete, 1
  partly received"; ADR-0011 and ADR-0018 aligned to it.
- Q: What form does the receipt date take? → A: A calendar date in Asia/Kolkata, not after
  today and not before the order's approval date (both as India dates; tests inject the
  clock). The database-set recorded-at time is stored beside it, and both appear in the
  audit entry and the timeline.
- The spec's two self-filled gaps were accepted: on a fully received order neither Cancel
  nor the owner-can't-act marker is shown; the demo seed gains receipt states.
- Q: Should the order lists show each order's receipt progress? → A: Yes, a badge, no
  new filter. Approved rows show "Partly received" or "Fully received" (nothing when
  nothing is received); cancelled rows with receipts show "Cancelled · partly
  received", matching the cancelled page. The open line count alone can't tell nothing
  from partly received (a 60-of-100 line is still open), so "partly received" is derived
  per row on the page from whether the order has any receipt (receipts carry their
  order), with no new stored value; page-1 query plans in each list scope prove it, and
  if a plan fails the owner sees it before any stored counter is added.
- Q: What is the speed target for one receipt covering all 500 lines? → A: 95% within
  500 ms (as a 500-line create, replace or submit); a single-line receipt stays at 150 ms;
  both measured over 50 timed runs after 3 warm-up; ADR-0012 updated. Plan note (owner):
  set-based writes (one statement for the receipts, one for their audit entries) and
  statement-level maintenance of the stored counts, with no per-line round trips.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Record a partial receipt on a line, across several deliveries (Priority: P1)

A Buyer opens their approved order, records that 40 of the 100 units on a line arrived,
and later records another 60. Each delivery is its own receipt event with its date, an
optional note and who recorded it. After each, the line shows how much has been received
and how much is outstanding, and the order shows its receipt progress.

**Why this priority**: It is the brief's core receipt requirement (§3.6) and the second
half of the integrity guarantee (outstanding never drifts).

**Independent Test**: On an approved one-line order of 100 units, record 40 then 60 and
check received, outstanding and progress after each, the two receipt events and their
audit entries.

**Acceptance Scenarios**:

1. **Given** an approved order owned by the Buyer with a line of 100 units and nothing
   received, **When** they record 40 received on that line with a date of today,
   **Then** the line shows 40 received and 60 outstanding, the order shows "partly
   received", one receipt event is stored, and one `GOODS_RECEIPT_RECORDED` audit entry
   records the line, 40, received before 0, after 40, outstanding after 60, the receipt
   date and the recorded-at time.
2. **Given** that line with 40 received, **When** they record 60 more, **Then** the line
   shows 100 received and 0 outstanding, and, if every line is now fully received, the
   order shows "fully received" and stays `APPROVED`.
3. **Given** a line with some received, **When** anyone who can read the order opens it,
   **Then** they see, per line, ordered, received and outstanding quantities and the
   receipt history (receipt date, quantity, note, who recorded it, recorded-at time),
   newest first and paginated; the order's timeline shows each receipt with both dates.
4. **Given** a receipt, **When** the order's `version` is read, **Then** it is unchanged:
   a receipt doesn't bump the order's version and needs no `If-Match`.
5. **Given** a receipt request retried with the same `Idempotency-Key` and body, **When**
   it arrives again, **Then** the original result is returned and nothing is recorded
   twice; the same key with a different body → `409 IDEMPOTENCY_KEY_REUSED`.

---

### User Story 2 - Receive several lines at once, all or nothing (Priority: P1)

A delivery often covers several lines. The Buyer records it as one receipt command naming
each line and its quantity. Either every line is recorded or none is: if any line would
exceed what is outstanding, the whole command is refused, naming every such line.

**Why this priority**: The brief requires that over-receipt is refused (§3.6), and a
delivery recorded half-way would leave the record misleading.

**Independent Test**: On an approved three-line order, send one command over all three
lines where one exceeds its outstanding; check the refusal names that line and nothing was
recorded on any line; then send a valid command and check three receipt rows and three
audit entries.

**Acceptance Scenarios**:

1. **Given** an approved order with lines A (10 outstanding), B (5) and C (8), **When** the
   owner records A 10, B 6, C 8 in one command, **Then** it is refused with `409
   RECEIPT_EXCEEDS_OUTSTANDING` naming line B (its outstanding 5 and the 6 requested), and
   no receipt and no audit entry is written for A, B or C.
2. **Given** the same order, **When** the owner records A 10, B 5, C 3, **Then** three
   receipt events and three `GOODS_RECEIPT_RECORDED` entries are written, one per line,
   sharing the command's date and note.
3. **Given** a line already fully received, **When** any positive quantity is recorded on
   it, **Then** `409 RECEIPT_EXCEEDS_OUTSTANDING` naming it.
4. **Given** a command, **When** a quantity is 0, negative, not an integer or above
   1,000,000; a line id isn't on this order or appears twice; the line list is empty; the
   date is after today in India time or before the order's approval date (India time);
   the note is over 500 characters; or the body has an unknown
   field, **Then** `400 VALIDATION_FAILED` with the field's code, and nothing is recorded.
5. **Given** a receipt, **When** the owner opens the receipt dialog before confirming,
   **Then** it shows per line: receiving N, received so far R, outstanding after M, and for
   each line it would fully receive, "This marks line X as fully received. Receipts can't
   be changed or undone."; it focuses the safe choice and sends one request on a double
   click.

---

### User Story 3 - Only the owner receives, and only on approved orders (Priority: P1)

Receipts are owner-only, so nobody who approved an order records its receipts, and only an
approved order can receive goods.

**Why this priority**: Authorization and the state machine are constitution principles
(II, III); ADR-0004's "Record receipt" row is binding and every cell must be tested.

**Independent Test**: Send a receipt on one approved order as each caller kind, and as the
owner on an order in every other state; check each code.

**Acceptance Scenarios**:

1. **Given** an approved order, **When** a receipt is sent by: the owner → recorded;
   another Buyer → `404`; a Buyer+Approver who isn't the owner → `403 NOT_ORDER_OWNER`; a
   pure Approver → `403 FORBIDDEN` "Approvers can review orders but not change them.",
   decided by role before the order is looked up, so the same answer comes for an order
   that doesn't exist; an Admin → `403 FORBIDDEN` "Admins can view orders but not change them.";
   a no-role user → `403 NO_ROLE_ASSIGNED`; anonymous → `401`.
2. **Given** an order owned by the Buyer in `DRAFT` (404 to non-owners as usual),
   `PENDING_APPROVAL`, `REJECTED` or `CANCELLED`, **When** the owner sends a receipt,
   **Then** `409 ORDER_NOT_RECEIVABLE` with the order's status, and nothing is recorded.
3. **Given** an approved order whose vendor has since been deactivated, **When** the owner
   records a receipt, **Then** it is recorded.
4. **Given** an approved order whose owner has lost BUYER, **When** they send a receipt,
   **Then** `403 FORBIDDEN`; if deactivated, `401 ACCOUNT_DEACTIVATED`; restoring access
   lets them receive again.
5. **Given** a receipt sent through raw SQL as the application's role, **When** it would
   exceed the line's ordered quantity, target a line of a non-approved order, or update or
   delete an existing receipt, **Then** the database refuses it, and received quantity and
   open line count can't be written directly.

---

### User Story 4 - Simultaneous receipts never over-receive (Priority: P1)

Two deliveries for the same line may be recorded at almost the same instant, from two
tabs or two people's clicks. The guarantee "received never exceeds ordered" must hold
however the requests interleave.

**Why this priority**: Brief §8 names this case explicitly; Principle V requires
concurrency tests that assert business outcomes.

**Independent Test**: Fire 50 receipt requests of 1 unit each at a line with fewer than 50
outstanding, released together by a barrier; check exactly the outstanding count succeed,
the rest get `409 RECEIPT_EXCEEDS_OUTSTANDING`, and reconciliation is clean.

**Acceptance Scenarios**:

1. **Given** a line with 30 outstanding, **When** 50 single-unit receipts are sent at once,
   **Then** exactly 30 succeed, 20 get `409 RECEIPT_EXCEEDS_OUTSTANDING`, received equals
   ordered, and there are exactly 30 receipt events and 30 audit entries.
2. **Given** two multi-line commands over overlapping lines sent at once, **When** both
   fit, **Then** both are recorded; **when** only one fits, **Then** exactly one is
   recorded in full and the other is refused in full; neither deadlocks.
3. **Given** receipts on different lines of one order at once, **When** they run, **Then**
   all are recorded (no needless conflict: no `If-Match`).
4. **Given** a receipt, **When** it locks, **Then** it locks the order first, then its
   lines in id order (ADR-0006), so no receipt can deadlock with an order command.

---

### User Story 5 - Cancelling an order that has received goods (Priority: P2)

An Approver can still cancel an approved order that is partly received: receipts are
kept, and the cancel records what was received. A fully received order can't be cancelled:
its goods have all arrived.

**Why this priority**: These are the cancel rules slice 5 deferred (ADR-0011); they close
FR-LCK-02.

**Independent Test**: Cancel orders with nothing, part and everything received; check the
outcomes, the dialog's summary, the audit entry, and that receipts after cancel are
refused.

**Acceptance Scenarios**:

1. **Given** an approved order with some lines partly received, **When** an Approver opens
   the cancel dialog, **Then** it shows each line's ordered and received quantity and a
   summary counting both kinds of line, for example "2 of 5 lines complete, 1 partly
   received" (a part that is zero is left out: "1 of 5 lines partly received", "2 of 5
   lines complete"; with nothing received, "Nothing received").
2. **Given** that order, **When** it is cancelled, **Then** it becomes `CANCELLED`, its
   receipts are kept, `PO_CANCELLED` records each line's ordered and received quantity at
   the moment of the cancel, and the cancelled page shows "Cancelled · 2 of 5 lines
   complete, 1 partly received" with per-line "60 of 100 received".
3. **Given** a fully received approved order, **When** an Approver cancels it, **Then**
   `409 ORDER_FULLY_RECEIVED`, the order is unchanged, the Cancel action isn't offered on
   its page, and the owner-can't-act marker isn't shown (there is nothing left to receive).
4. **Given** a cancelled order, **When** its owner sends a receipt, **Then** `409
   ORDER_NOT_RECEIVABLE`, and its lines' outstanding quantities still read
   `ordered − Σ receipts`.
5. **Given** a cancel and a receipt that would fully receive the order sent at once,
   **When** both run, **Then** exactly one of two outcomes: the cancel wins and the
   receipt gets `409 ORDER_NOT_RECEIVABLE`, or the receipt wins and the cancel gets `409
   ORDER_FULLY_RECEIVED`; with a partial receipt instead, either both succeed (receipt
   first, recorded in `PO_CANCELLED`'s received quantities) or the receipt is refused
   (cancel first). Never a cancelled order whose `PO_CANCELLED` disagrees with its
   receipts, and never a deadlock.

---

### User Story 6 - The Admin sees a user's open orders before changing them (Priority: P3)

Before changing a user's roles or deactivating them, the Admin sees how many open orders
that user owns: drafts, pending, and approved with lines still to receive. Those orders
will follow the "no reassignment" process (an Approver rejects pending ones and cancels
approved ones).

**Why this priority**: Deferred from slice 1 until counts can be non-zero (ADR-0019,
amended 2026-11-12); it informs a decision that ends what another person can do.

**Independent Test**: For a Buyer with known drafts, pending orders, approved orders with
and without open lines, and closed orders, check the counts on the user detail, on the
update response, and in both dialogs.

**Acceptance Scenarios**:

1. **Given** a Buyer with 2 drafts, 1 pending order, 3 approved orders of which 1 is fully
   received, 1 rejected and 1 cancelled, **When** the Admin opens their detail, **Then**
   it shows open orders: 2 draft, 1 pending, 2 approved with lines to receive.
2. **Given** the change-role or deactivate dialog for that user, **When** it opens,
   **Then** it shows the same three counts, and, when any is above zero, what happens to
   them (an Approver rejects the pending ones and cancels the approved ones).
3. **Given** a user with no orders, an Approver or an Admin, **When** the Admin opens their
   detail, **Then** all three counts are 0.
4. **Given** an admin update, **When** it returns, **Then** the response carries the
   counts too.

---

### Edge Cases

- The receipt date is the delivery date the Buyer states, a calendar date in Asia/Kolkata;
  the recorded-at time is when the server stored it. A receipt recorded at 00:30 IST may
  be dated today (IST), even though it is still yesterday in UTC; a date after today (IST)
  or before the order's approval date (IST) → `400`; the approval date itself is allowed.
- A receipt request without `Idempotency-Key` → `400 VALIDATION_FAILED`
  (field code `REQUIRED` on the `Idempotency-Key` header, as for order creates).
- A receipt that names a line of another order (even one the caller owns) → `400`, the line
  doesn't belong to this order; nothing is recorded.
- A multi-line command of up to 500 lines (the order's maximum) is accepted in one
  transaction.
- A receipt dialog opened on a stale page whose line has since been partly received by
  another tab: the server refuses an over-receipt with the line's current outstanding, the
  dialog shows the error inside with "Reload order".
- A cancel dialog opened before a receipt arrives: the cancel records the received
  quantities as they are under its lock, not as the dialog showed them; if the receipt made
  the order fully received, the dialog shows `ORDER_FULLY_RECEIVED` inside with "Reload
  order".
- Receipt progress is derived: nothing received, partly received, fully received; a
  fully received order is still `APPROVED`, and stays editable by nobody.
- A cancelled order can't be fully received (cancel is refused on a fully received order,
  and receipts are refused after a cancel), so a cancelled row's badge is only ever
  "Cancelled · partly received" or none.
- An approved order fully received leaves the open count "approved with lines to receive".
- A receipt never recomputes the order total; a receipt statement recomputes the open line
  count once per statement, not per row.
- The demo seed adds receipt states (a partly and a fully received order per demo Buyer,
  and the cancelled one partly received), made through the receipt service; seeing them on
  an existing local stack needs the documented reset.

## Requirements *(mandatory)*

### Functional Requirements

**Recording receipts (ADR-0011, brief §3.6, §4)**

- **FR-001** (FR-RCV-01): The owner of an `APPROVED` order MUST be able to record a
  receipt covering one or more of its lines, each with a positive integer quantity, a
  receipt date (a calendar date in Asia/Kolkata, not after today and not before the
  order's approval date, both as India dates), and an optional note of 0–500 characters;
  each line becomes its own immutable receipt event recording the line, quantity, receipt
  date, recorded-at time (database clock) and the recording user.
- **FR-002** (FR-RCV-01): A receipt command MUST be all-or-nothing: if any line would
  exceed its outstanding quantity, it MUST be refused with `409
  RECEIPT_EXCEEDS_OUTSTANDING` naming every such line (position, outstanding, quantity
  asked), and nothing MUST be recorded.
- **FR-003** (FR-RCV-02): Each line's received quantity MUST always equal the sum of its
  receipts, and its outstanding quantity MUST equal ordered minus received and never be
  negative, on every path, raw SQL as the application's role included (INV-3, INV-4).
- **FR-004** (FR-RCV-02): Receipts MUST be append-only: no update, delete, reversal or
  negative receipt, by the API or by raw SQL as the application's role.
- **FR-005** (FR-RCV-03): Anyone who can read an order MUST be able to read its receipt
  history: its receipts, each with its lines, paginated with a stable sort, newest
  first.
- **FR-006** (NFR-AUD-01): Each receipt line MUST write one `GOODS_RECEIPT_RECORDED`
  audit entry in the same transaction, with the receipt's id, the line, quantity, received before and
  after, outstanding after, the receipt date and the recorded-at time; the order's
  timeline shows both dates.
- **FR-007** (NFR-CON-03): A receipt MUST take an `Idempotency-Key` and no `If-Match`, and
  MUST NOT change the order's version.
- **FR-008** (FR-RPT-03): The order's open line count MUST stay equal to the number of
  lines with received below ordered after every receipt, maintained once per statement,
  and MUST be included in reconciliation (INV-6).
- **FR-009** (NFR-PERF-03): A receipt MUST cause zero order-total recomputes.

**Who and when (ADR-0001, ADR-0004)**

- **FR-010** (FR-SM-01, FR-APR-01): A receipt MUST be accepted only on an `APPROVED`
  order; on any other state, `409 ORDER_NOT_RECEIVABLE`, and the database MUST refuse it
  for raw SQL too.
- **FR-011** (FR-OWN-01, FR-ACT-01): The "Record receipt" row of ADR-0004's matrix MUST
  hold for every caller kind, as amended 2026-11-24: a pure Approver gets `403 FORBIDDEN`
  "Approvers can review orders but not change them." by role, before the order is looked
  up; a Buyer+Approver who isn't the owner gets `403 NOT_ORDER_OWNER`.
- **FR-012** (FR-ACC-07): A user who lost BUYER MUST be refused (`403`) and a deactivated
  user (`401`), checked under the request's locks like approve and cancel.
- **FR-013** (FR-VEN-02): A receipt MUST be accepted whatever the vendor's status.

**Concurrency (ADR-0006, brief §8)**

- **FR-014** (FR-RCV-04): 50 receipts released at once on one line MUST never make
  received exceed ordered.
- **FR-015** (NFR-CON-01): A receipt MUST lock the order first, then its lines in id
  order; no receipt path may lock a `users` row before an order or line.

**Cancel with receipts (ADR-0011, ADR-0001 T10)**

- **FR-016** (FR-LCK-02): Cancelling a fully received order MUST be refused with `409
  ORDER_FULLY_RECEIVED`; with nothing or part received it MUST succeed and keep the
  receipts.
- **FR-017** (FR-LCK-02, NFR-AUD-01): `PO_CANCELLED` MUST record each line's received
  quantity as it is under the cancel's lock.
- **FR-018** (NFR-CON-01): A cancel and a receipt on the same order at once MUST end in
  one of the outcomes of User Story 5, scenario 5, with no deadlock.

**Frontend (ADR-0018)**

- **FR-019** (NFR-FE-09): The owner of an approved order with something outstanding MUST be
  offered Record receipt: a form over the lines with outstanding quantities and a
  confirmation dialog as in User Story 2, scenario 5.
- **FR-020** (NFR-FE-09): The cancel dialog MUST show each line's ordered and received
  quantity and the received summary ("2 of 5 lines complete, 1 partly received"), and a
  cancelled order's page MUST show the same summary; the Cancel action MUST NOT be offered on a fully
  received order.
- **FR-021** (NFR-FE-08): Every order page MUST show, per line, ordered, received and
  outstanding; the order's receipt progress; and the receipt history.
- **FR-021a** (NFR-FE-08, NFR-PERF-01): Every order list (the Buyer's own, the Approver's,
  the Admin's, the Buyer+Approver's combined list) MUST show a receipt-progress badge:
  on approved rows "Partly received" or "Fully received" (none when nothing is received);
  on cancelled rows with any receipt "Cancelled · partly received". It MUST be derived
  per row on the page (fully received from the stored open line count; partly from
  whether the order has any receipt), with no new stored value and no new filter, and
  each list scope's page-1 query plan MUST stay within its committed plan test; a failing
  plan is shown to the owner before any stored counter is considered.
- **FR-022** (NFR-FE-07): The end-to-end flow MUST cover create → submit → approve →
  partial receipt → a receipt that fully receives a line (with the fully-received wording),
  on Chromium per PR and on all three browsers nightly and on `main`.

**Admin open-order counts (ADR-0016, ADR-0019)**

- **FR-023** (FR-ADM-02): The Admin's user detail and the admin update response MUST carry
  the user's open-order counts: drafts, pending, and approved with lines to receive;
  the change-role and deactivate dialogs MUST show them.

**Integrity (brief §6)**

- **FR-024** (FR-PO-03, FR-RCV-02): The integrity attack suite MUST cover the outstanding
  half: raw-SQL writes to received quantity or the open line count, receipt update or
  delete, over-receipt, a receipt on a non-approved order; each refused, and reconciliation
  returns zero rows after it.

### Key Entities

- **Receipt** (a goods received note): one delivery recorded by one command: its order,
  receipt date (India calendar date, user-supplied), recorded at (database clock),
  recorded by, note, and one or more receipt lines. Immutable.
- **Receipt line**: what one receipt received on one order line: line, quantity (> 0);
  a receipt names a line once. Every receipt line belongs to the receipt's order.
  Immutable.
- **Order line** (extended): received quantity (derived, stored, guarded) and outstanding
  quantity (ordered − received).
- **Order** (extended): open line count (derived, stored, guarded); receipt progress
  (derived, not stored).
- **Open-order counts** (per user, read-only): drafts, pending, approved with lines to
  receive.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 50 simultaneous single-unit receipts on a line with 30 outstanding record
  exactly 30, in each of 10 repeated runs, with reconciliation clean every time.
- **SC-002**: Every cell of the "Record receipt" row, for each caller kind and each order
  state, returns its documented code.
- **SC-003**: Every raw-SQL attack on receipts, received quantity and open line count is
  refused, and reconciliation returns zero rows afterwards.
- **SC-004**: The cancel-versus-receipt race, repeated 10 times in each start order, ends
  every time in one of the documented outcomes with no deadlock.
- **SC-005**: 95% of single-line receipts complete within 150 ms and 95% of 500-line
  receipts within 500 ms (ADR-0012), each over 50 timed runs after 3 warm-up runs.
- **SC-006**: A Buyer records a delivery covering three lines, from opening the order to
  seeing the updated quantities, in under one minute.
- **SC-007**: The receipt dialog and the order page's receipt section have no accessibility
  violations (axe).

## Assumptions

- Receipt quantities follow the line quantity rule: integers 1–1,000,000 (ADR-0007).
- A pure Buyer who isn't the owner can't read the order, so gets `404`.
- The open-order count "approved with lines to receive" counts `APPROVED` orders with at
  least one line not fully received.
- The outstanding report is slice 7; this slice keeps the stored open line count it will
  read correct.
- No email or notification on receipt (ADR-0019).

## Dependencies

- Slice 5 (merged): cancel, its lock order, `PO_CANCELLED` with per-line received
  quantities, the owner-can't-act marker.
- ADR-0003 (derived values and the receipt trigger), ADR-0006 (lock order), ADR-0011
  (receipts and cancellation), ADR-0016 and ADR-0019 (open-order counts), ADR-0018
  (dialogs).
