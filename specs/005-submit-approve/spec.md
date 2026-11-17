# Feature Specification: Slice 4 — Submission, routing, approval, rejection and withdrawal

**Feature Branch**: `005-submit-approve`

**Created**: 2026-11-17

**Status**: Draft

**Input**: User description: "Slice 4: submit and approve (Submission and routing), from
docs/BRIEF.md's approval clauses. Carry these slice 3 notes into the spec: the
order_status_transitions rows for submit, approve, reject, withdraw (if the brief allows
it), and what happens to lines and the editor once submitted (PO006 already locks lines);
the specific error codes that replace slice 3's placeholders: an edit/delete of a readable
order you don't own (NOT_ORDER_OWNER per ADR-0004) and of an order past DRAFT (instead of
INVALID_STATE_TRANSITION); separation of duties: an Approver never approves their own
order (ADR-0004); the Buyer+Approver order list, revisited with an approval queue
(ADR-0004 note); the Admin user detail's pending count stays in slice 6 (ADR-0019)."

## Context

Slice 3 delivered drafts whose totals can't drift. This slice lets a draft leave `DRAFT`
and brings it to a decision. The owner submits it. The system routes it by its exact total
against the current approval policy: at or below the threshold the system approves it on
submit; above it, the order waits for an Approver (brief §3.4). The chain of approval steps
is data-driven, one step per tier exceeded, so a second tier is a policy row and never a
code change (§8). An Approver approves or rejects the waiting order. While it waits, the
owner can withdraw it to make changes and submit again, and routing is recomputed from the
new total: this is the answer to §3.4's "a line changed mid-approval". Once submitted, an
order's lines, total and vendor can't change by any path (§3.5). The database has refused
line changes outside `DRAFT` since slice 3, and the vendor is frozen as a snapshot at
submit.

The users are:
- a **Buyer**, who submits and withdraws their own orders and sees each one's routing
  outcome
- an **Approver**, who works an approval queue and approves or rejects orders they don't
  own, and from this slice reads every non-draft order and its timeline
- a **Buyer+Approver**, who acts as owner on their own orders and as Approver on others',
  never both on one order
- a **Procurement Admin**, who reads everything and changes no order
- an **operator**, who sets the approval policy from the server's CLI

The binding documents are the [constitution](../../.specify/memory/constitution.md), the
ADRs in [docs/adr/](../../docs/adr/README.md) and [docs/BRIEF.md](../../docs/BRIEF.md).
This spec states *what* must be true. Mechanisms and numbers are in ADR-0001 (states
T4–T9, the lock rules, `ORDER_PENDING_APPROVAL`), ADR-0002 (policy, chain, seed, CLI,
withdraw voids the round), ADR-0004 (visibility, matrix, `SELF_APPROVAL`,
`NOT_ORDER_OWNER`, the approval queue), ADR-0005 (active vendor at submit and approve,
vendor snapshot), ADR-0006 (versions, lock order, concurrency tests), ADR-0007 (errors),
ADR-0012 (targets), ADR-0016 (audit catalogue), ADR-0018 (dialogs, approver queue, nav
count) and ADR-0019 (deferred counts).

Traceability:
- §2 → FR-ACT-01 (the approve row)
- §3.1, §3.5 → FR-VEN-03 (vendor snapshot)
- §3.4 → FR-APR-01, FR-APR-02 (edit pending → 409; withdraw → edit → resubmit re-routes)
- §3.5 → FR-LCK-01 (the edit and delete paths of submitted orders; the `REJECTED` and
  `CANCELLED` lock tests complete in slice 5 with cancel)
- §6 → NFR-AUTH-01 (approve, reject), NFR-AUD-01 (each approval decision), NFR-PERF-01
  (approver queue)
- §8 → FR-APR-03
- Production layer: FR-SM-01 (T4–T9), FR-SM-03 (withdraw and reject), FR-SOD-01 (approve,
  reject), FR-OWN-01 (non-draft cells), FR-APR-04, FR-APR-05, NFR-CON-01, NFR-CON-03
  (submit, approve, reject, withdraw), NFR-AUD-03 (Approver timelines), NFR-FE-07
  (create → submit → approve), NFR-FE-08 (pending-approvals nav count), NFR-FE-09
  (submit, withdraw, approve and reject dialogs)

## Clarifications

### Session 2026-11-17

- Q: Do reject (T8) and withdraw (T9) land in this slice? → A: Yes. Submit and approve
  alone strand pending orders, with no way to say no or take a wrong submission back.
  Owner decision, recorded as constitution 3.0.2 (slice order: slice 4 is submission,
  routing, approve, reject and withdraw; slice 5 keeps cancel and the remaining locks).
- Q: Which code does editing or deleting a `PENDING_APPROVAL` order return? → A: A new
  `409 ORDER_PENDING_APPROVAL`, message "This order is waiting for approval. Withdraw it
  to make changes."; an `APPROVED` order stays `409 ORDER_LOCKED`. Owner decision,
  recorded in ADR-0001 and ADR-0007 (2026-11-17).
- Q: How do the Buyer+Approver's order list and the approval queue fit together? → A: One
  combined order list (own orders in any state plus every non-draft order), unchanged. The
  approval queue, and the nav count read from it, hold only orders the caller may
  approve: never their own. Owner decision, recorded in ADR-0004 (2026-11-17).
- Q: How does `ORDER_LOCKED` on a rejected order avoid reading as "approved"? → A: One
  code; the message follows `details.status`. `APPROVED`: "This order is approved and
  locked." `REJECTED`: "This order was rejected and is closed. Raise a new order instead."
  Copying a rejected order to a new draft is considered and deferred (ADR-0019, owner
  decision 2026-11-17).
- Q: What happens when an Approver approves a pending order whose owner has been
  deactivated or no longer holds BUYER? → A: Refused with `409 ORDER_OWNER_INACTIVE`,
  "The buyer who raised this order can no longer act on it. Reject it, or approve once their access is restored." Reject stays allowed. The owner is checked under a shared lock
  on their user row in the approve transaction, so a concurrent deactivation or role
  removal can't slip between check and approval. The queue, order detail and Approve
  dialog mark such orders "Owner can no longer act on this order" and offer Reject
  instead. Owner decision, recorded in ADR-0001, ADR-0006, ADR-0007 and ADR-0016
  (2026-11-17).
- Q: Does order detail show the reject and withdraw reasons? → A: Yes, beside the
  approval step or round they ended.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Submit a draft and see where it went (Priority: P1)

The owner submits a finished draft. The system decides, from the order's exact total and
the current approval policy, whether it is approved at once or waits for approval, and
tells the Buyer which. From then on the order can't be edited.

**Why this priority**: Submission is the gate between a working draft and a commitment to
a vendor (§3.2, §3.4). Nothing after it (approval, receipt, the outstanding report) can
happen without it.

**Independent Test**: With the seeded policy, submit one draft totalling ₹1,00,000.00 and
one totalling ₹1,00,000.01. The first comes back `APPROVED` with a `SYSTEM` auto-approval
entry; the second `PENDING_APPROVAL` with a one-step chain. Both show the vendor snapshot,
and an edit of either is refused with its specific `409`.

**Acceptance Scenarios**:

1. **Given** a draft whose total is at or below the lowest tier (₹1,00,000.00 on the
   seeded policy), **When** the owner submits it with the current version, **Then** it
   becomes `APPROVED` in the same transaction, with a `PO_SUBMITTED` entry by the owner
   and a `PO_AUTO_APPROVED` entry by `SYSTEM` naming the threshold and policy version.
2. **Given** a draft whose total is above the lowest tier (₹1,00,000.0001 or
   ₹1,00,000.01), **When** it is submitted, **Then** it becomes `PENDING_APPROVAL` with a
   chain of one step per tier exceeded, all open, and `PO_SUBMITTED` records the total, the
   tiers in the chain, the policy version and the resulting status.
3. **Given** a submit, **Then** the order records the policy version it was routed by, and
   a snapshot of the vendor's name, contacts and payment terms. Non-draft orders display
   the snapshot, and a later vendor edit or deactivation doesn't change it.
4. **Given** a draft whose vendor is inactive, **When** it is submitted, **Then** `409
   VENDOR_INACTIVE` and nothing changes.
5. **Given** a stale version, **Then** `409 VERSION_CONFLICT`; **given** no `If-Match`,
   **Then** `400` with field code `VERSION_REQUIRED`; **given** any body field, **Then**
   `400 UNKNOWN_FIELD` (submit takes no input).
6. **Given** an order already submitted, **When** it is submitted again, **Then** `409
   INVALID_STATE_TRANSITION` with the current status and the attempted action in
   `details`.
7. **Given** the web app, **When** the owner submits, **Then** a dialog shows the saved
   total, the *expected* outcome ("Will be auto-approved" or "Will go to the Approver for
   approval", from the published policy), "You can't edit it after submitting; you can
   withdraw it while it's pending"; after the server answers, the page shows the actual
   outcome, which is what counts.

---

### User Story 2 - Submitted orders are locked (Priority: P1)

After submission, nothing about an order's lines, total or vendor can change: not through
the editor, not through a direct API call, not through raw SQL as the application's role.
Each attempt gets a clear, specific failure.

**Why this priority**: §3.5 and §6 make this a checked requirement, proven by a test, not
a UI check.

**Independent Test**: For a pending order, an approved order and a rejected order, try
edit, delete, a raw-SQL line insert/update/delete, a raw-SQL vendor change and a raw-SQL
delete; each is refused with its specific outcome and the reconciliation returns zero rows.

**Acceptance Scenarios**:

1. **Given** an `APPROVED` or `REJECTED` order, **When** its owner edits or deletes it
   through the API, **Then** `409 ORDER_LOCKED` with the current status in `details`, and
   a message that follows that status: `APPROVED` → "This order is approved and locked.";
   `REJECTED` → "This order was rejected and is closed. Raise a new order instead." The
   web app shows the same sentence, chosen by `code` and `details.status`.
2. **Given** a `PENDING_APPROVAL` order, **When** its owner edits or deletes it, **Then**
   `409 ORDER_PENDING_APPROVAL` with the current status in `details` and the message "This
   order is waiting for approval. Withdraw it to make changes."
3. **Given** a Buyer+Approver and another buyer's non-draft order (readable to them),
   **When** they edit, delete, submit or withdraw it, **Then** `403 NOT_ORDER_OWNER`,
   replacing slice 3's unreachable placeholder. A pure Approver is refused at the route
   (`403 FORBIDDEN`, before validation, as slice 3 tests); an Admin gets `403 FORBIDDEN`
   "Admins can view orders but not change them."; another Buyer still gets `404`
   (research R9 S2, pending sign-off).
4. **Given** a submitted order, **When** raw SQL as the application role changes its
   lines, vendor, vendor snapshot, recorded policy version or header, or deletes it,
   **Then** the database refuses it (lines since slice 3; the rest from this slice).
5. **Given** the web app, **When** a submitted order is opened, **Then** it shows
   read-only detail (vendor snapshot, lines, total, status, approval chain with each
   rejection or withdrawal reason, timeline) with
   no Edit, Delete or Submit actions; a stale editor tab that saves gets the specific code
   with a "Reload order" option, and for a pending order the message says to withdraw it.

---

### User Story 3 - Approve an order from the queue (Priority: P1)

An Approver opens the approval queue, picks the oldest pending order, reviews it and
approves the current step. On the last step the order becomes `APPROVED`, and the buyer
can receive goods against it (slice 6).

**Why this priority**: §3.4 requires approval above the threshold before goods receipt;
§6 requires each approval decision to be tied to a real user and traced.

**Independent Test**: Submit a ₹2,00,000 order as Buyer A; Approver P sees it in the queue
and approves it; it becomes `APPROVED` with an `APPROVAL_STEP_APPROVED` entry recording
the step, tier, version approved and P as actor; it leaves the queue.

**Acceptance Scenarios**:

1. **Given** a pending order with one open step, **When** an Approver who doesn't own it
   approves with the current version, **Then** the step is recorded as approved by them,
   bound to that version, and the order becomes `APPROVED` (T7).
2. **Given** a two-tier policy fixture and an order above both tiers, **When** the first
   step is approved, **Then** the order stays `PENDING_APPROVAL` with the next step open
   (T6); **when** the second is approved, **Then** `APPROVED` (T7). A three-tier chain
   works by inserting a policy row only, with no code change.
3. **Given** a pending order whose vendor has been deactivated, **When** an Approver
   approves, **Then** `409 VENDOR_INACTIVE` and nothing changes.
4. **Given** a pending order whose owner has been deactivated or no longer holds BUYER,
   **When** an Approver approves, **Then** `409 ORDER_OWNER_INACTIVE` with the message
   "The buyer who raised this order can no longer act on it. Reject it, or approve once their access is restored." and nothing changes; rejecting it succeeds;
   once the owner's access is restored, approving succeeds.
5. **Given** a stale version, **Then** `409 VERSION_CONFLICT`; **given** no `If-Match`,
   **Then** `400 VERSION_REQUIRED`; **given** an order not pending, **Then** `409
   INVALID_STATE_TRANSITION`.
6. **Given** an Approver, **When** they open the approval queue, **Then** they see only the
   `PENDING_APPROVAL` orders they may approve (never their own), paginated, oldest
   submission first, with PO number, buyer, vendor (snapshot), total, current step,
   submitted time and whether the owner can still act, filtered in the database.
7. **Given** the web app, **When** an Approver approves, **Then** a dialog names the PO
   number, buyer, vendor and total and states "The buyer can then receive goods; the order
   can't be edited"; errors are shown inside the dialog; the nav's pending-approvals count
   updates after the action. **Given** an order whose owner can't act, **Then** the
   queue, the order detail and the dialog show "Owner can no longer act on this order"
   and offer Reject instead of Approve.
8. **Given** a successful approval, **Then** exactly one `APPROVAL_STEP_APPROVED` entry is
   written in the same transaction, with `actingRole` `APPROVER` (also for a dual-role
   user).

---

### User Story 4 - Reject an order (Priority: P1)

An Approver who won't approve an order rejects it with a reason. Rejection is final: the
buyer raises a new order if the purchase is still needed.

**Why this priority**: Without it, an Approver can only approve or leave orders waiting
forever (owner decision, 2026-11-17).

**Independent Test**: Approver P rejects Buyer A's pending ₹2,00,000 order with a reason;
it becomes `REJECTED`, leaves the queue, can't be edited, withdrawn, approved or deleted,
and `APPROVAL_STEP_REJECTED` records the tier, step and reason.

**Acceptance Scenarios**:

1. **Given** a pending order the Approver doesn't own, **When** they reject it with a
   reason and the current version, **Then** the current step is recorded as rejected by
   them and the order becomes `REJECTED` (T8), final.
2. **Given** no reason, an empty or whitespace-only reason, or one over 500 characters,
   **Then** `400` naming the field (`REQUIRED` or `TOO_LONG`).
3. **Given** a pending order whose vendor has been deactivated, **When** it is rejected,
   **Then** it succeeds (reject is allowed when approve isn't).
4. **Given** a two-step chain with the first step approved, **When** the second is
   rejected, **Then** the order is `REJECTED` and the first step keeps its approved record.
5. **Given** a `REJECTED` order, **When** anyone tries to submit, approve, reject or
   withdraw it, **Then** `409 INVALID_STATE_TRANSITION`; **when** its owner edits or
   deletes it, **Then** `409 ORDER_LOCKED` with "This order was rejected and is closed.
   Raise a new order instead." There is no copy-to-new-draft action (ADR-0019).
6. **Given** the web app, **When** an Approver rejects, **Then** a dialog requires the
   reason and states "Rejection is final; the buyer must raise a new order", with the safe
   choice focused.

---

### User Story 5 - Withdraw, change and resubmit (Priority: P1)

The owner spots a mistake in a pending order. They withdraw it with a reason, it returns
to `DRAFT`, they correct it and submit again, and routing is recomputed from the new total
with a fresh chain.

**Why this priority**: This is ADR-0001's answer to §3.4's "a line item is added or
changed while the order is mid-approval and the total crosses the threshold".

**Independent Test**: Submit a ₹1,50,000 order (pending); withdraw it with a reason; edit
it down to ₹90,000; resubmit: it auto-approves. The old round's step is `VOIDED`, and the
timeline shows submitted → withdrawn → edited → submitted → auto-approved.

**Acceptance Scenarios**:

1. **Given** a pending order and its owner, **When** they withdraw it with a reason and
   the current version, **Then** it returns to `DRAFT` (T9), every step of the current
   round becomes `VOIDED` (decided steps keep their decision record), and `PO_WITHDRAWN`
   records the reason and the voided steps.
2. **Given** a withdrawn order, **Then** it is editable and deletable again as a draft,
   shows the live vendor, and a resubmit builds a fresh chain under the then-current
   policy and takes a fresh vendor snapshot.
3. **Given** a withdraw with no reason, an empty one or one over 500 characters, **Then**
   `400`; **given** a stale version, **Then** `409 VERSION_CONFLICT`; **given** an order
   not pending, **Then** `409 INVALID_STATE_TRANSITION`.
4. **Given** a withdraw racing an approve on the same version, **Then** exactly one
   succeeds; the other gets `409 VERSION_CONFLICT`, and the final state matches the winner.
5. **Given** the web app, **When** the owner withdraws, **Then** a dialog requires the
   reason and states "It returns to Draft, and approval starts again when you resubmit".

---

### User Story 6 - Separation of duties (Priority: P1)

Nobody approves or rejects an order they own, even when they hold both Buyer and Approver
roles.

**Why this priority**: Principle III and ADR-0004; the control is pointless if the
requester can decide on their own order.

**Independent Test**: A Buyer+Approver submits a ₹5,00,000 order and tries to approve and
to reject it: `403 SELF_APPROVAL` each time, the order stays pending, no decision is
recorded, and it never appears in their queue or count.

**Acceptance Scenarios**:

1. **Given** a Buyer+Approver who owns a pending order, **When** they approve or reject
   it, **Then** `403 SELF_APPROVAL` (after `404` and before any `409`, per ADR-0004's
   precedence), and no step or audit entry changes.
2. **Given** the same user and another buyer's pending order, **When** they approve or
   reject it, **Then** it succeeds, recorded with `actingRole` `APPROVER`.
3. **Given** the same user, **Then** their own pending orders appear in their order list
   but never in their approval queue or its count; the web app never offers Approve or
   Reject on an order they own.
4. **Given** the error registry and every code path, **Then** `DUPLICATE_APPROVER` appears
   nowhere.

---

### User Story 7 - Approval policy (Priority: P2)

The operator sets the threshold from the server's CLI; every role can read the current
policy, which the submit dialog uses to predict the outcome.

**Why this priority**: Routing needs a policy, and changes to it must be versioned and
audited, but the seeded policy is enough to demonstrate the slice.

**Independent Test**: `policy:show` prints version 1 with one tier at ₹1,00,000;
`policy:set --tier1 200000` creates version 2, audited as `OPERATOR`; the next submission
of ₹1,50,000 auto-approves, while an order submitted under version 1 keeps its chain.

**Acceptance Scenarios**:

1. **Given** the production seed, **Then** the policy has exactly one tier, ₹1,00,000.
2. **Given** `policy:set` with a valid amount, **Then** a new version takes effect for new
   submissions only, audited as `APPROVAL_POLICY_CHANGED` with `actorType` `OPERATOR`,
   before → after, `osUser` and `host`; the current value is a no-op with exit zero; `0`,
   a negative, 5 decimal places or a non-number → error, non-zero exit, no new version.
3. **Given** Buyer, Approver or Admin, **When** they read the current policy, **Then**
   they get its version and tiers; a no-role user gets `403 NO_ROLE_ASSIGNED`; no HTTP
   route writes it.

---

### User Story 8 - Visibility of submitted orders (Priority: P1)

Approvers now see every non-draft order and its timeline; Buyers still see only their own;
Admins see all; lists stay scoped and filtered in the database.

**Why this priority**: The ADR-0004 matrix is binding cell by cell, and this slice is the
first with non-draft states.

**Independent Test**: Run the matrix for read, list, timeline, edit, delete, submit,
withdraw, approve, reject and the queue, for `DRAFT`, `PENDING_APPROVAL`, `APPROVED` and
`REJECTED`, against owner Buyer, other Buyer, Approver, Buyer+Approver, Admin, no role and
anonymous.

**Acceptance Scenarios**:

1. **Given** an Approver, **When** they list orders or read a non-draft order or its
   timeline, **Then** it succeeds; a draft (including a withdrawn order) returns `404`.
2. **Given** a Buyer+Approver, **Then** their order list holds their own orders in any
   state and every non-draft order, in one list; their queue holds only others' pending
   orders.
3. **Given** an Admin, **When** they submit, withdraw, approve or reject, **Then** `403
   FORBIDDEN` at route level, before validation.
4. **Given** a Buyer, **When** they open the queue, approve or reject, **Then** `403`
   before validation; another buyer's order still returns `404`.

---

### Edge Cases

- Edit racing submit on one draft (same version): exactly one succeeds; the other gets
  `409 VERSION_CONFLICT`; the final status matches the routing of the final total.
- Two approve requests on the same step (double click, two tabs), or approve racing
  reject: exactly one decision is recorded; the other gets `409 VERSION_CONFLICT` or
  `INVALID_STATE_TRANSITION`.
- A policy change between submit and approve doesn't change the order's chain; a
  withdraw and resubmit after the change uses the new policy.
- A total exactly at a tier boundary routes as "at or below"; one ten-thousandth of a
  rupee above routes as "above" (exact comparison, never a float).
- Raw SQL setting status `DRAFT` → `APPROVED` without an auto-approval, or `PENDING_APPROVAL`
  → `APPROVED` with an open step, or any status change out of `REJECTED`, is refused by the
  database.
- Withdraw after the first of two steps was approved: both steps of the round are
  `VOIDED`, the first keeps who approved it and when; a resubmit starts a new round from
  step one.
- A vendor edited after submit: the order still shows the submit-time snapshot; after a
  withdraw it shows the live vendor again until the next submit.
- An owner deactivated, or stripped of BUYER, while their order is pending: approving it
  is refused with `409 ORDER_OWNER_INACTIVE` and it is marked in the queue; the Approver
  rejects it (ADR-0016's process), or approves once the owner's access is restored.
- An Approver's APPROVER role removed while their dialog is open: the next approve or
  reject is `403`; steps they already approved stay valid.
- The only Approver also holds Buyer: their own orders above the threshold can never be
  approved (ADR-0002's accepted consequence); the owner can still withdraw them.
- Submit, approve and withdraw/reject bodies: submit and approve accept no body or `{}`;
  any field → `400`. Withdraw and reject take only `reason`.
- Many withdraw/resubmit cycles keep every round's steps and decisions; only the current
  round decides the order.

## Requirements *(mandatory)*

### Functional Requirements

**Submission and routing**

- **FR-001** (FR-APR-01, FR-SM-01): The owner MUST be able to submit a `DRAFT` with the
  current version. Routing compares the exact total with the current policy: at or below
  the lowest tier → `APPROVED` (T4); above → `PENDING_APPROVAL` (T5).
- **FR-002** (FR-APR-03): A submission above the lowest tier MUST build a chain of one
  step per tier the total strictly exceeds, in ascending order, from versioned policy
  data, with no code path special-casing the number of tiers.
- **FR-003** (FR-APR-01): An auto-approval MUST be an audited decision by `SYSTEM`
  (`PO_AUTO_APPROVED`, threshold, policy version), written in the submit transaction.
- **FR-004** (FR-VEN-03): Submit MUST refuse an inactive vendor (`409 VENDOR_INACTIVE`),
  checked under lock, and MUST store a snapshot of the vendor's name, contacts and payment
  terms; non-draft orders are read and listed with the snapshot, drafts with the live
  vendor.
- **FR-005**: Each submission MUST record the policy version it used; later policy changes
  MUST NOT affect it.

**State machine and lock**

- **FR-006** (FR-SM-01): The order status transitions table MUST gain the rows for T4–T9,
  and the database MUST refuse every other status change, and `→ APPROVED` unless the
  current round's chain is complete or a `SYSTEM` auto-approval exists.
- **FR-007** (FR-LCK-01): In every non-draft state the database MUST refuse changes to
  lines (already, `PO006`), the vendor, the vendor snapshot and the recorded policy
  version, and the order's delete. The API MUST answer edit and delete of a
  `PENDING_APPROVAL` order with `409 ORDER_PENDING_APPROVAL`, and of an `APPROVED` or
  `REJECTED` order with `409 ORDER_LOCKED`, each with the current status in `details`.
  `ORDER_LOCKED` stays one code; its message follows `details.status` (`APPROVED`: "This
  order is approved and locked."; `REJECTED`: "This order was rejected and is closed.
  Raise a new order instead."), in the API's problem `detail` and in the web app.
- **FR-008** (FR-OWN-01): Edit, delete, submit and withdraw by a Buyer who can read the
  order but doesn't own it (a Buyer+Approver on another buyer's non-draft order) MUST
  return `403 NOT_ORDER_OWNER`, replacing slice 3's placeholder; callers without BUYER
  are refused at the route first. ADR-0004's check precedence applies (route 403 before
  400 before 404 before order 403 before 409).
- **FR-009**: Any other (state, action) pair MUST return `409 INVALID_STATE_TRANSITION`
  with the current status and attempted action in `details`.

**Decisions**

- **FR-010** (FR-APR-01, FR-SM-01): An Approver MUST be able to approve the current open
  step of a pending order with the current version; the decision binds to that version.
  If steps remain the order stays pending (T6); on the last step it becomes `APPROVED`
  (T7). Approve MUST refuse an inactive vendor with `409 VENDOR_INACTIVE`, and an owner
  who is deactivated or no longer holds BUYER with `409 ORDER_OWNER_INACTIVE` ("The buyer who raised this order can no longer act on it. Reject it, or approve once their access is restored."),
  checked with the owner's user row under a shared lock in the approve transaction
  (ADR-0006's lock order: order, lines, vendor, owner). Reject is allowed in both cases.
- **FR-011** (FR-SM-03): An Approver MUST be able to reject a pending order with the
  current version and a required reason (trimmed, 1–500 characters, plain text). The
  current step is recorded as rejected, the order becomes `REJECTED` (T8) and is final.
  Reject is allowed when the vendor is inactive.
- **FR-012** (FR-SM-03, FR-APR-02): The owner MUST be able to withdraw a pending order with
  the current version and a required reason (same rules). It returns to `DRAFT` (T9); every
  step of the current round becomes `VOIDED`, decided steps keep their decision record;
  the next submit builds a fresh round and a fresh snapshot.
- **FR-013** (FR-SOD-01): Approve and reject by the order's owner MUST return `403
  SELF_APPROVAL`, whatever roles they hold. `DUPLICATE_APPROVER` MUST NOT exist in the
  registry or any code path.
- **FR-014** (FR-OWN-01, NFR-PERF-01): Approvers MUST have an approval queue holding only
  `PENDING_APPROVAL` orders they may approve (never their own), paginated per ADR-0007,
  oldest submission first (submitted time, then id), filterable by vendor and PO-number
  prefix in the database with index support. Each row MUST say whether the owner can still
  act. Its `total` MUST serve the nav's pending-approvals count, under the same scope.

**Policy**

- **FR-015** (FR-APR-05): The approval policy MUST be versioned data, seeded with one tier
  at ₹1,00,000, changed only by the operator CLI (`policy:set`, `policy:show`) per
  ADR-0002, and audited `APPROVAL_POLICY_CHANGED` with `actorType` `OPERATOR`.
- **FR-016** (FR-APR-04): Buyer, Approver and Admin MUST be able to read the current
  policy's version and tiers; no HTTP route writes it.

**Concurrency and input**

- **FR-017** (NFR-CON-01, NFR-CON-03): Submit, approve, reject and withdraw MUST require
  `If-Match`, lock the order before deciding, and pass the concurrency tests: edit vs
  submit, double approve, approve vs reject, withdraw vs approve, approve vs vendor
  deactivation, approve vs the owner's deactivation or BUYER removal (approved before
  the change, or `409 ORDER_OWNER_INACTIVE` after it, never approved after it), and
  approve and reject vs the acting Approver's own deactivation or APPROVER removal
  (decided before, or `401 ACCOUNT_DEACTIVATED` / `403 FORBIDDEN` after, never decided
  after). Approve and reject lock the owner's and the Approver's user rows last, in id
  order (ADR-0006, 2026-11-17).
- **FR-018** (NFR-VAL-01): Submit and approve take no input besides the version; reject
  and withdraw take only `reason`. Any other field MUST be refused with `400`. All four
  endpoints join the body-schema inventory.

**Visibility and audit**

- **FR-019** (FR-OWN-01, NFR-AUTH-02): Access MUST follow ADR-0004's matrix for every order
  action in `DRAFT`, `PENDING_APPROVAL`, `APPROVED` and `REJECTED`, for every caller kind
  and anonymous, each cell tested. Approvers read non-draft orders, their lists and
  timelines. The Buyer+Approver order list stays one combined list (ADR-0004, 2026-11-17).
  Route-level `403 FORBIDDEN` carries a role-specific message, one shared constant each
  for the API `detail` and the web app: Admin "Admins can view orders but not change
  them."; pure Approver on edit, submit, withdraw or delete "Approvers can review orders but not change them."; pure Buyer
  on approve or reject "Only Approvers can approve or reject orders." (ADR-0004, 2026-11-17).
- **FR-020** (NFR-AUD-01): Submit MUST write `PO_SUBMITTED` (plus `PO_AUTO_APPROVED` when
  routed to `APPROVED`); approve `APPROVAL_STEP_APPROVED` (tier, step, version approved);
  reject `APPROVAL_STEP_REJECTED` (tier, step, reason); withdraw `PO_WITHDRAWN` (reason,
  voided steps), each in the same transaction, with the actor's capacity. Refused commands
  write none.
- **FR-021**: The Admin user detail's open-order counts (draft, pending, approved with open
  lines) are NOT part of this slice: they arrive together in slice 6 (ADR-0019, amended
  2026-11-12).

**Performance**

- **FR-022** (NFR-PERF-01): Submitting a 500-line order MUST meet ADR-0012's p95 of
  500 ms, a single approval 150 ms, and the approver queue 150 ms with every pending order
  in one queue (one Approver, production dataset). The queue's page and count query plans
  MUST be committed at ADR-0012's dataset sizes, and the order-list plans re-committed
  where the Approver's scope adds a path.

**Web app**

- **FR-023** (NFR-FE-07, NFR-FE-08, NFR-FE-09): The web app MUST provide the Submit action
  and dialog on a draft; the Withdraw action and dialog on the owner's pending order; a
  read-only order detail for submitted orders (snapshot, lines, total, status, approval
  chain with each step's state, decider and, for a rejection or withdrawal, its reason,
  timeline); the approval queue screen; the Approve and Reject actions and dialogs, with
  the "Owner can no longer act on this order" marker offering Reject instead of Approve; and the Approvers' nav pending-approvals count
  (refreshed every 60 s, on focus and after each related action). Errors are handled by
  `code` and shown inside dialogs; a conflict offers "Reload order"; nothing is sent twice.
- **FR-024**: End-to-end tests MUST cover: create → submit below the threshold
  (auto-approved) → locked; create → submit above → appears in the Approver's queue →
  approve → `APPROVED`; submit → reject → `REJECTED`; submit → withdraw → edit → resubmit
  re-routes; a Buyer+Approver doesn't see their own order in the queue and can't approve
  it.
- **FR-025**: With demo seeding on, the seed MUST include orders in each reachable state
  (`DRAFT`, `PENDING_APPROVAL`, auto- and step-`APPROVED`, `REJECTED`, and a withdrawn
  draft), and the reconciliation MUST return zero rows after it.

### Key Entities

- **Approval policy version**: a version number, an effective time and one or more tiers
  (each a threshold); immutable once created; the latest is current.
- **Approval round and step**: each submission above the threshold opens a round; each
  step belongs to one round, with its tier, position in the chain, state (`OPEN`,
  `APPROVED`, `REJECTED`, `VOIDED`), the deciding user, the decision time, the order
  version decided against and, for a rejection, the reason. Rounds are kept forever; only
  the current one decides the order.
- **Purchase order** (extended): submitted time, the policy version used, the vendor
  snapshot (name, contacts, payment terms); `PENDING_APPROVAL`, `APPROVED` and `REJECTED`
  reachable.
- **Order status transition**: the allowed (from, to, action) rows the database checks.
- **Audit entry (order)**: `PO_SUBMITTED`, `PO_AUTO_APPROVED`, `APPROVAL_STEP_APPROVED`,
  `APPROVAL_STEP_REJECTED`, `PO_WITHDRAWN`; `APPROVAL_POLICY_CHANGED` for the policy.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Buyer submits a finished draft and learns its outcome (approved or waiting)
  in under 30 seconds, without needing to know the threshold.
- **SC-002**: 100 % of seeded boundary cases route correctly: exactly at the threshold
  auto-approves, one ten-thousandth above waits for one step; the two- and three-tier
  fixtures produce two- and three-step chains with no code change.
- **SC-003**: Every edit, delete and raw-SQL change attempted on a submitted order is
  refused with its specific outcome; none succeeds silently; reconciliation returns zero
  rows.
- **SC-004**: Zero self-decisions in every test: each approve or reject by an owner,
  dual-role or not, is refused, and no owner ever sees their own order in their queue.
- **SC-005**: Every concurrent double-approve, approve-vs-reject, withdraw-vs-approve and
  approve-vs-owner-deactivation ends with exactly one recorded outcome, and no order is
  approved after its owner lost the ability to act; every edit-vs-submit race ends with one success
  and a final status matching the final total.
- **SC-006**: Submit of a 500-line order within 500 ms, a single approval within 150 ms,
  and the approver queue's first page within 150 ms, all at p95 on ADR-0012's production
  dataset.
- **SC-007**: Every matrix cell for `DRAFT`, `PENDING_APPROVAL`, `APPROVED` and `REJECTED`
  (seven caller kinds, anonymous included) has a passing test; every successful submit,
  approval, rejection and withdrawal has exactly its audit entries, and every refused one
  none.
- **SC-008**: The new screens and dialogs have zero automated accessibility violations.

## Assumptions

- **Scope** (constitution 3.0.2): cancel, `CANCELLED` and its lock tests are slice 5;
  receipts (and `ORDER_NOT_RECEIVABLE`) slice 6; the outstanding report and load tests
  slice 7.
- **`ORDER_LOCKED` lands here** for `APPROVED` and `REJECTED`, because both are reachable in
  this slice and the constitution forbids a non-specific failure on any edit path.
- **Queue order**: oldest submission first, so the longest-waiting order is decided first.
- **Reasons** for reject and withdraw follow the delete reason's rules (trimmed plain
  text, at most 500 characters, line breaks allowed, other control characters refused),
  but are required.
- **Successive steps**: with the single-tier seed there's one step; on a multi-tier
  fixture the same Approver may decide successive steps (ADR-0002: decide again if a
  second tier is ever seeded).
- **No notifications**: email on submit, approve or reject stays deferred (ADR-0019).
- **Error codes come from the ADRs**: `ORDER_PENDING_APPROVAL` and `ORDER_OWNER_INACTIVE`
  (ADR-0001 and ADR-0007, 2026-11-17), `ORDER_LOCKED`, `NOT_ORDER_OWNER`, `SELF_APPROVAL`,
  `INVALID_STATE_TRANSITION`, `VENDOR_INACTIVE`, `VERSION_CONFLICT`, `VERSION_REQUIRED`.
  Those not yet in the code registry (`packages/contracts`) and the web app's message map
  are added during implementation, tests first, after the contract review at
  `/speckit-plan`.
- **Infrastructure**: no new services or dependencies.

## Dependencies

- Constitution 3.0.2; ADR-0001, 0002, 0004, 0005, 0006, 0007, 0012, 0016, 0018 and 0019 as
  currently amended.
- Slice 1: user status and roles, read for the owner check under a shared lock.
- Slice 3: orders, lines, derived-value triggers, the status-transition table and trigger
  (`PO009`), the line lock outside `DRAFT` (`PO006`), the reconciliation and attack suite,
  the order editor and detail.
- Slice 2: the vendor lock and active check, the vendor fields for the snapshot.
- Slice 5 adds cancel and the `CANCELLED` lock on this slice's chain and lock; slice 6 adds
  receipts against `APPROVED` orders and the Admin open-order counts.
