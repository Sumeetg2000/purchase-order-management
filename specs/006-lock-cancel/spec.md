# Feature Specification: Slice 5 — Cancel approved orders, and the remaining locks

**Feature Branch**: `006-lock-cancel`

**Created**: 2026-11-20

**Status**: Draft

**Input**: User description: "Slice 5: lock and cancel (constitution slice order, owner
decision 2026-11-17: reject and withdraw already shipped in slice 4). Cancel an order with
a required reason, plus the remaining order locks (cancelled orders locked like approved
and rejected ones; every edit path refused on a cancelled order). Follow ADR-0001
(lifecycle, cancel transitions), ADR-0002/ADR-0004 (who may cancel, SELF_APPROVAL on
cancel for dual-role users, matrix cells), ADR-0006 (lock order), and the traceability
rows slice 4 left Tested for later slices: FR-LCK-01 (cancelled part), FR-SM-01 (cancel
transitions), FR-SOD-01 (cancel), FR-OWN-01 (cancelled cells). First task of the slice,
before any cancel work: the slice 4 service timings (backend/tests/plans/orders.timing.test.ts
submit/approve) use 50 timed runs after 3 warm-up, like the page timings; targets
unchanged."

## Context

Slice 4 brought an order from draft to a decision: approved, rejected, or back to draft.
An approved order is locked (brief §3.5), and the brief allows exactly one action on it:
**cancellation, by an Approver, with a reason, recorded distinctly from an edit**. This
slice adds that action (ADR-0001 T10) and completes the locks: a cancelled order is final
and closed like a rejected one, and every path that could change it is refused, by the
application with a specific error and by the database for raw SQL.

Cancelling is also the documented way to close an approved order whose owner has left
(ADR-0004, ADR-0016: no owner transfer): an Approver cancels it and a new order is raised.

The users are:
- an **Approver**, who cancels approved orders they don't own, with a reason
- a **Buyer**, who sees their own order cancelled, who did it, when and why, and can't
  change it
- a **Buyer+Approver**, who cancels other buyers' approved orders, never their own
- a **Procurement Admin**, who reads cancelled orders and their timelines and changes none

**Carried over from slice 4** (first task, before any cancel work): the service timings
for submit and approve take 50 timed runs after 3 warm-up runs, as the page timings do,
so one slow sample no longer decides the 95th percentile. Targets are unchanged (submit
≤ 500 ms, one approval ≤ 150 ms).

**Goods receipt is slice 6.** Receipts don't exist yet, so in this slice every approved
order has nothing received. ADR-0011's rule that a fully received order can't be
cancelled (`409 ORDER_FULLY_RECEIVED`), the "nothing / partly received" summary in the
cancel dialog beyond "nothing received", and the cancel-versus-receive race arrive with
receipts in slice 6.

## Clarifications

### Session 2026-11-20

- Q: What does a pure Buyer get when they cancel? → A: `403 FORBIDDEN` "Only Approvers
  can cancel orders." at route level, owner or not; ADR-0004's cancel row amended (asked
  during `/speckit-specify`). A whitespace-only reason is `TOO_SHORT`, "Enter a reason."
- Q: How does the app point Approvers to an approved order whose owner can't act? → A: A
  marker on the order page only (no list change). An Approver who may cancel it sees "Its owner can no longer act on it, so receipts can't be recorded. To close it, cancel it, and a buyer can raise a new order if the goods are still needed."
  Everyone else who can read it sees "Its owner can no longer act on it, so receipts can't be recorded."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cancel an approved order (Priority: P1)

An Approver opens an approved order they don't own, chooses Cancel order, gives a reason
and confirms. The order becomes Cancelled, final, and its timeline shows who cancelled it,
when and why. The owner sees the same.

**Why this priority**: It is the only action the brief allows on an approved order, and
the documented way to close one whose owner has left.

**Independent Test**: An Approver cancels an approved order with a reason; the order reads
`CANCELLED` with the reason, the canceller and the time; the timeline holds one
`PO_CANCELLED` entry distinct from any edit; the owner and an Admin read the same.

**Acceptance Scenarios**:

1. **Given** an approved order owned by a Buyer, **When** an Approver cancels it with the
   version they read and a reason, **Then** it becomes `CANCELLED`, its version increases,
   and one `PO_CANCELLED` audit entry records the Approver (acting as Approver), the
   reason, and each line's ordered and received quantity.
2. **Given** an order auto-approved on submit (a `SYSTEM` decision), **When** an Approver
   cancels it, **Then** it is cancelled the same way.
3. **Given** a cancel without a reason, **Then** `400` with the field named; with a reason
   that is empty or only whitespace, `400` `TOO_SHORT` on `reason` (the web app says
   "Enter a reason.", as slice 4's reject and withdraw); longer than 500 characters,
   `400` `TOO_LONG`; nothing changes in any case.
4. **Given** a cancel with no version, **Then** `400` with `VERSION_REQUIRED`; with a stale
   version, `409 VERSION_CONFLICT`; nothing changes either way.
5. **Given** the order's vendor was deactivated after approval, **When** an Approver
   cancels it, **Then** the cancel succeeds.
6. **Given** the order's owner was deactivated or lost the Buyer role after approval,
   **When** an Approver cancels it, **Then** the cancel succeeds (it is how such an order
   is closed).
7. **Given** the Approver confirms Cancel order in the app, **Then** a dialog has named the
   order, its buyer, vendor and total, what was received per line (nothing, in this
   slice), required a reason, and said that cancelling is final and no further receipts
   can be recorded; focus started on the safe choice; after success the page shows the
   order cancelled with the reason.
8. **Given** an approved order whose owner has been deactivated or lost the Buyer role,
   **When** an Approver who may cancel it opens it, **Then** the page says "Its owner can
   no longer act on it, so receipts can't be recorded. To close it, cancel it, and a buyer
   can raise a new order if the goods are still needed." Anyone else who can read it (an
   Admin, or the owner if they can still sign in) sees only the first sentence. Order
   lists don't change.

---

### User Story 2 - Only the right people cancel, and only approved orders (Priority: P1)

Nobody cancels an order they own, whatever roles they hold. Buyers who aren't Approvers,
and Admins, can't cancel. Only an approved order can be cancelled.

**Why this priority**: Separation of duties and the state machine are principles (III,
II); a cancel by the wrong person or from the wrong state is a control failure.

**Independent Test**: The authorization matrix's cancel row passes for every caller kind
and every order state, and every refusal leaves the order unchanged with no audit entry.

**Acceptance Scenarios**:

1. **Given** a Buyer+Approver's own approved order, **When** they cancel it, **Then**
   `403 SELF_APPROVAL` and nothing changes.
2. **Given** a pure Buyer (the owner or another Buyer), **When** they cancel any order,
   **Then** `403 FORBIDDEN` with "Only Approvers can cancel orders.", at route level
   before validation and before any order lookup, so nothing about the order leaks.
3. **Given** an Admin, **When** they cancel any order, **Then** `403 FORBIDDEN` with
   "Admins can view orders but not change them."
4. **Given** a no-role user, **Then** `403 NO_ROLE_ASSIGNED`; an anonymous caller, `401`.
5. **Given** an Approver (or a Buyer+Approver) and another buyer's draft, **When** they
   cancel it, **Then** `404` (they can't read it).
6. **Given** a pending, rejected or already cancelled order an Approver can read, **When**
   they cancel it, **Then** `409 INVALID_STATE_TRANSITION`, with the order's status and the
   cancel action named.
7. **Given** an Approver whose account is deactivated, or whose Approver role is removed,
   between reading the order and confirming, **Then** the cancel is refused
   (`401 ACCOUNT_DEACTIVATED` or `403 FORBIDDEN`) and nothing changes.

---

### User Story 3 - A cancelled order is locked and final (Priority: P1)

Once cancelled, nothing about the order changes again: not its lines, total, vendor, status
or decisions, by any route or by raw SQL as the application.

**Why this priority**: Brief §3.5 and Principle II: non-draft orders are locked, and
`CANCELLED` is final.

**Independent Test**: Every write path on a cancelled order is refused with its specific
code, and every raw-SQL change to it, its lines or its approval records is refused by the
database.

**Acceptance Scenarios**:

1. **Given** a cancelled order, **When** its owner edits or deletes it, **Then**
   `409 ORDER_LOCKED` with the order's status, and the message "This order was cancelled
   and is closed."
2. **Given** a cancelled order, **When** anyone submits, withdraws, approves, rejects or
   cancels it, **Then** `409 INVALID_STATE_TRANSITION` with the status and the action
   (after the usual role, visibility and ownership checks).
3. **Given** a cancelled order (or a rejected one: both are final), **When** the
   application's database role tries to change any of its columns (status and version
   included), its lines, vendor, submission columns, approval round or steps, or delete
   it, **Then** the database refuses each change.
4. **Given** an approved order, **When** the application's database role sets it
   `CANCELLED` directly, without the cancel's record, **Then** the database refuses it at
   commit or before.
5. **Given** an editor open on an approved order that is cancelled meanwhile, **When** the
   owner saves, **Then** the page shows the cancelled message, not a generic error.

---

### User Story 4 - Cancelled orders are visible to the right people (Priority: P2)

The owner, every Approver and every Admin read a cancelled order, its cancel reason and its
timeline; other Buyers don't. Cancelled orders appear in order lists with their status and
can be filtered by it.

**Why this priority**: Visibility rules (ADR-0004) must hold for the new state; the
cancel reason is what procurement asks for in a dispute.

**Independent Test**: The matrix's read, timeline and list rows pass for cancelled orders
for every caller kind.

**Acceptance Scenarios**:

1. **Given** a cancelled order, **Then** its owner, any Approver and any Admin read it and
   its timeline; another Buyer gets `404`; a no-role user `403 NO_ROLE_ASSIGNED`.
2. **Given** an order list filtered to Cancelled, **Then** each caller sees the cancelled
   orders they can read, and nothing else.
3. **Given** a cancelled order, **Then** it is never in an approval queue or its count.
4. **Given** a cancelled order's detail page, **Then** it shows the status Cancelled, who
   cancelled it, when and the reason, and offers no action.

---

### User Story 5 - Concurrent cancels and decisions end in one outcome (Priority: P2)

Two Approvers cancelling the same order, or a cancel racing an Approver's deactivation or
role removal, end in exactly one consistent outcome.

**Why this priority**: Principle V; the brief §8 asks for correctness under concurrency.

**Independent Test**: Each race, started together and interleaved deterministically,
leaves one recorded cancel or none, never two, and never a cancel by someone who had lost
the right to cancel when it committed.

**Acceptance Scenarios**:

1. **Given** two Approvers cancelling the same approved order with the same version,
   **Then** exactly one succeeds and the other gets `409` (`VERSION_CONFLICT` or
   `INVALID_STATE_TRANSITION`); one `PO_CANCELLED` entry exists.
2. **Given** a cancel racing the acting Approver's deactivation or Approver-role removal,
   **Then** the order is either cancelled before the change or the cancel is refused
   after it, never cancelled after it.
3. **Given** a cancel racing the vendor's deactivation or the owner's deactivation,
   **Then** the cancel succeeds either way, and nothing deadlocks.

---

### Edge Cases

- A cancel whose reason is at the 500-character limit succeeds; one character over is
  refused at the field.
- A reason with surrounding whitespace is stored trimmed; a reason of only whitespace
  trims to empty and is refused `TOO_SHORT`, shown at the field as "Enter a reason.", as
  for reject and withdraw.
- A cancel on an order id that doesn't exist, or isn't a valid id, gets `404` / `400` as
  every other order action does.
- A cancel request with any field besides `reason` is refused (`400`, unknown field).
- An Approver who opens the cancel dialog while another Approver cancels the order gets a
  failure in the dialog that offers Reload order; after reloading, the page shows the
  order cancelled and offers no action.
- An approve, reject or withdraw sent from a stale page to an order that has since been
  cancelled is refused with `INVALID_STATE_TRANSITION` (cancel only starts from
  `APPROVED`, where none of the three applies).
- A cancelled order keeps its vendor snapshot, approval round and decided steps exactly as
  they were; the round isn't reopened or voided.
- The demo seed's cancelled order per demo Buyer is made through the cancel service, so it
  carries a real `PO_CANCELLED` entry.

## Requirements *(mandatory)*

### Functional Requirements

**Cancel (ADR-0001 T10, ADR-0011, brief §3.5)**

- **FR-001** (FR-LCK-02): An Approver MUST be able to cancel an `APPROVED` order they
  don't own, with a required reason of 1–500 characters (trimmed) and the version they
  read; the order becomes `CANCELLED`, which is final.
- **FR-002** (FR-LCK-02): A cancel MUST be recorded as one `PO_CANCELLED` audit entry,
  distinct from every edit event, in the same transaction, with the acting Approver and
  their acting role, the reason, and each line's ordered and received quantity.
- **FR-003** (FR-LCK-02): A cancelled order MUST show who cancelled it, when and why, to
  everyone who can read it.
- **FR-004** (FR-VEN-02): Cancel MUST succeed whether or not the order's vendor is active.
- **FR-005** (FR-ACT-01): Cancel MUST succeed whether or not the order's owner is still
  active or still a Buyer.

**Who may cancel (ADR-0004, ADR-0002)**

- **FR-006** (FR-SOD-01): Nobody may cancel an order they own: a Buyer+Approver gets
  `403 SELF_APPROVAL`, checked before any `409`.
- **FR-007** (FR-OWN-01): The cancel row of ADR-0004's authorization matrix MUST hold for
  every caller kind (owner Buyer, owner Buyer+Approver, other Buyer, Approver, other
  Buyer+Approver, Admin, no role, anonymous) and every order state, with the check
  precedence 401 → `NO_ROLE_ASSIGNED` → route `FORBIDDEN` → 400 → 404 → order-level 403 →
  409. A pure Buyer, owner or not, gets route-level `403 FORBIDDEN` "Only Approvers
  can cancel orders." (ADR-0004's cancel row, amended 2026-11-20 by owner decision); `404`
  applies only to callers holding APPROVER who can't read the order.
- **FR-008** (FR-OWN-01): The acting Approver's status and Approver role MUST be checked
  again when the cancel commits, so a deactivation or role removal that committed first
  refuses it.

**State and locks (ADR-0001)**

- **FR-009** (FR-SM-01): Cancel MUST be allowed only from `APPROVED`; from any other state
  the request is refused with `409 INVALID_STATE_TRANSITION` naming the status and the
  cancel action.
- **FR-010** (FR-LCK-01): Editing or deleting a `CANCELLED` order MUST be refused with
  `409 ORDER_LOCKED` carrying the status, with the message "This order was cancelled and
  is closed."; submit, withdraw, approve, reject and cancel MUST be refused with
  `409 INVALID_STATE_TRANSITION`.
- **FR-011** (FR-LCK-01, FR-SM-01): The database MUST refuse, for the application's role,
  any change to a cancelled or rejected order (any column, `version` included), its lines, its vendor and submission columns, its
  approval rounds and steps, and its deletion; and MUST refuse a change to `CANCELLED`
  that isn't the cancel transition with its record.
- **FR-012** (FR-SM-01): The state table's cancel transition (`APPROVED` → `CANCELLED`)
  MUST have one allowed and one refused test per starting state.

**Visibility (ADR-0004)**

- **FR-013** (FR-OWN-01): A cancelled order MUST be readable, with its timeline, by its
  owner, every Approver and every Admin, and by no other Buyer (`404`); lists include it
  under its status and can be filtered to it.
- **FR-014** (FR-OWN-01): A cancelled order MUST never appear in an approval queue or its
  count.

**Concurrency (ADR-0006)**

- **FR-015** (NFR-CON-01): Cancel MUST lock in ADR-0006's order (the order first, users
  rows last) and decide only on what it has locked; the races in User Story 5 MUST end in
  one consistent outcome without deadlock.
- **FR-016** (NFR-CON-03): Cancel MUST require `If-Match` with the order's version: missing
  → `400 VERSION_REQUIRED`, mismatch → `409 VERSION_CONFLICT`.

**Web app (ADR-0018)**

- **FR-017** (NFR-FE-09): An Approver who doesn't own an approved order MUST be offered
  Cancel order on its detail page; the dialog MUST name the order, buyer, vendor and
  total, show what was received per line (nothing, in this slice), require a reason, say cancelling is final and
  no further receipts can be recorded, start focus on the safe choice, offer Reload order
  when the order changed, and say a refused reason at the field.
- **FR-017a** (NFR-FE-09): An approved order whose owner can't act MUST show a marker on
  its page to everyone who can read it: "Its owner can no longer act on it, so receipts
  can't be recorded." An Approver who may cancel it also sees "To close it, cancel it, and
  a buyer can raise a new order if the goods are still needed." Order lists and the queue
  don't change. The wording is one shared constant per sentence.
- **FR-018** (NFR-FE-08): A cancelled order's page MUST show the Cancelled status, the
  canceller, time and reason, and offer no action; the order list's status filter MUST
  include Cancelled.

**Carried over**

- **FR-019** (NFR-PERF-01): The submit and approve service timings MUST take 50 timed runs
  after 3 warm-up runs, as the page timings do; targets unchanged.

### Key Entities

- **Purchase order**: gains the `CANCELLED` state reachable from `APPROVED` only; keeps
  its approval date; records when, by whom and why it was cancelled.
- **Cancel record**: the reason, the canceller (a real Approver) and the time, readable
  with the order; `PO_CANCELLED` in the audit trail with each line's ordered and received
  quantity.
- **Order lock**: what may never change once an order leaves `DRAFT`, now including every
  part of a cancelled order.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every cell of the cancel row of the authorization matrix, for all 8 caller
  kinds and all 5 order states, returns its documented result, and every refused
  request leaves the order and the audit trail unchanged.
- **SC-002**: 100% of write paths on a cancelled order (6 API actions and every raw-SQL
  change by the application's role) are refused, and a reconciliation run after the
  slice's attack tests finds zero inconsistencies.
- **SC-003**: Each concurrency race in User Story 5, repeated 10 times, ends every time in
  exactly one documented outcome, with no deadlock and never more than one cancel record.
- **SC-004**: An Approver cancels an approved order from its page in under 30 seconds,
  with a reason, and the result is visible to the owner on their next page load.
- **SC-005**: The cancel dialog and the cancelled order's page have no accessibility
  violations (WCAG 2.1 AA checks).
- **SC-006**: A cancel is as fast as an approval: 95% of cancels complete within 150 ms
  at the recorded dataset sizes (ADR-0012's decision target), measured like submit and
  approve: 50 timed runs after 3 warm-up runs.

## Assumptions

- Receipts arrive in slice 6. Until then every line's received quantity is zero, so the
  cancel's audit entry records zero received per line, and the dialog shows nothing
  received. The fully-received refusal (`409 ORDER_FULLY_RECEIVED`), the partly-received
  display and the cancel-versus-receive race are tested in slice 6.
- The reason follows ADR-0007's rule for withdraw, reject and cancel reasons: plain text,
  1–500 characters after trimming.
- The cancel's record (who, when, why) is readable on the order itself as well as in the
  timeline, as a rejection's reason is on its step.
- A cancelled order keeps its approval round and steps as they were; cancel is not an
  approval decision and adds no step.
- No notification is sent on cancel (ADR-0019: email notifications deferred).
- The demo seed gains a cancelled order per demo Buyer, made through the cancel service.
- Owner transfer stays out of scope (ADR-0019); cancelling and raising a new order is the
  documented path.

## Dependencies

- Slice 4: approved orders, the approval round and steps, the order version and
  `If-Match`, the authorization matrix test and the dialogs' Reload order.
- ADR-0001 (T10, locks), ADR-0004 (matrix, precedence, separation of duties), ADR-0006
  (lock order), ADR-0007 (reasons), ADR-0011 (cancellation), ADR-0016 (`PO_CANCELLED`),
  ADR-0018 (the cancel dialog).
