# Feature Specification: Slice 3 — Draft orders and the integrity suite

**Feature Branch**: `004-draft-orders`

**Created**: 2026-11-12

**Status**: Draft

**Input**: User description: "Slice 3: Draft purchase orders and the integrity suite, from
docs/BRIEF.md's order clauses (3.2 raising a purchase order, 3.3 the order total is
derived, and the order-related checks in section 6: bad input, real vendor, actor on every
action, totals never mismatched on any path, filtered order lists, structured trace on
raising). Submission/routing, lock/withdraw/reject/cancel, goods receipt and the
outstanding report are later slices."

## Context

Today orders live in spreadsheets whose totals disagree with their own lines, and nobody
can say who changed what (brief §1). This slice delivers the purchase order itself: a
Buyer raises an order against a real, active vendor, with one or more lines, and the
system derives every line total and the order total. No code path, whether the web app,
a direct API call or raw SQL as the application's database role, can leave the total out
of step with the lines (§3.3, §6). Orders exist only as drafts in this slice: the owner
can edit or delete a draft, but submission and approval arrive in slice 4.

The users are:
- a **Buyer**, who raises orders, edits and deletes their own drafts, and lists and reads
  their own orders and their timelines
- a **Procurement Admin**, who reads every order, drafts included, and its timeline, and
  changes nothing
- an **Approver**, who never sees another buyer's drafts. Every order in this slice is a
  draft, so an Approver's order list is empty until slice 4.

The binding documents are the [constitution](../../.specify/memory/constitution.md), the
ADRs in [docs/adr/](../../docs/adr/README.md) and [docs/BRIEF.md](../../docs/BRIEF.md).
This spec states *what* must be true. The mechanisms and numbers are in ADR-0001 (states
T1–T3, PO numbers), ADR-0003 (derived values, database roles, the attack suite), ADR-0004
(visibility and the matrix), ADR-0005 (vendor active check), ADR-0006 (versions,
idempotency, lock order), ADR-0007 (field rules, errors, pagination), ADR-0009 (line
identity), ADR-0010 (money), ADR-0012 (targets), ADR-0015 (open-line count), ADR-0016
(audit) and ADR-0018 (frontend).

Traceability:
- §2 → FR-ACT-01 (the create-order row)
- §1 → FR-PO-05
- §3.1 → FR-VEN-02 (create and edit)
- §3.2 → FR-PO-01, FR-PO-02 (create → `DRAFT`), FR-PO-06
- §3.3 → FR-PO-03, FR-PO-07, NFR-DATA-01
- §4 → FR-PO-04
- §6 → NFR-VAL-01 (order inputs), NFR-AUTH-01, NFR-AUD-01 (raising), NFR-AUD-03 (order
  timelines), NFR-PERF-01 (order lists)
- Production layer: FR-SM-02, FR-OWN-01 (draft cells), FR-RPT-03 (line-driven part),
  NFR-CON-01, NFR-CON-03, NFR-PERF-03 (line-driven part), NFR-FE-01 (version-conflict
  reload), NFR-FE-03, NFR-FE-06 (editor), NFR-FE-09 (delete-draft dialog, unsaved-changes
  guard)

## Clarifications

### Session 2026-11-12

- Q: Does an order carry any header field besides its vendor? → A: No. An order is its
  vendor and its lines (§3.2); delivery fields stay deferred (ADR-0019).
- Q: Which filters do order lists offer? → A: Status, vendor, PO-number prefix and a
  created-date range, each run in the database and backed by an index.
- Q: Do the order counts deferred to "the orders slice" land here? → A: The
  vendor-deactivation dialog's count of the caller's drafts using the vendor lands in this
  slice. The Admin user detail's open-order counts (draft, pending, approved with open
  lines) arrive together in slice 6, when each can be non-zero; ADR-0019 is amended to
  match (2026-11-12).
- Q: Once a Buyer deletes a draft, can they still open its timeline? → A: No; only an
  Admin, by the order's id. The former owner gets `404`, and the delete dialog warns
  "You won't be able to see this draft or its history again."
- Q: What is a line description, and how large may an order request be? → A: A
  description is single-line plain text: control characters (line breaks and tabs
  included) are refused, and "500 characters" counts Unicode code points. The request
  limit for order writes must fit the largest valid order (500 lines × 500 four-byte
  characters), proven by a test that sends it, and the proxy's limit matches the API's.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Raise a draft order (Priority: P1)

A Buyer picks an active vendor, enters one or more lines (description, quantity, unit
price) and saves. The order gets its PO number and is saved as a draft. The system works
out each line total and the order total; the Buyer never types a total.

**Why this priority**: Raising an order is the system's reason to exist (§3.2), and every
later slice acts on an order raised here.

**Independent Test**: As a Buyer, create an order with three lines against an active
vendor; it comes back as `DRAFT` with a PO number, exact line totals and the exact sum as
its total, and its timeline shows one `PO_CREATED` entry.

**Acceptance Scenarios**:

1. **Given** a Buyer and an active vendor, **When** they create an order with lines
   (description, quantity, unit price), **Then** it is saved in `DRAFT` with the caller
   as owner, a PO number in the `PO-{FY}-{seq}` format, each line's total = quantity ×
   unit price, the order total = the sum of line totals, version 1, and lines in the order
   sent.
2. **Given** lines `0.1 × 1` three times, or `7 × 0.0125`, **When** the order is created,
   **Then** the total is exactly `0.3000` or `0.0875`, as decimal strings, with no
   rounding.
3. **Given** a vendor id that doesn't exist, **When** the order is created, **Then** it
   is refused with `400 VALIDATION_FAILED`, field code `VENDOR_NOT_FOUND`, and nothing is
   written. **Given** an inactive vendor, **Then** it is refused with `409
   VENDOR_INACTIVE`.
4. **Given** no lines, more than 500 lines, a quantity that is 0, negative, fractional or
   over 1,000,000, a negative unit price, one with more than 4 decimal places or over
   999,999,999.9999, or an empty description, **When** the order is created, **Then** it
   is refused with `400` naming each failing field, before any business rule runs.
5. **Given** a body containing `total`, `lineTotal`, `poNumber`, `position`, `version`,
   `status`, an owner, or any unknown field, **When** it is sent, **Then** it is refused
   with `400` (field code `READ_ONLY_FIELD` or `UNKNOWN_FIELD`), never silently ignored.
6. **Given** a create whose response was lost, **When** the client retries with the same
   `Idempotency-Key` and body, **Then** it gets the original order back and no second
   order exists. **When** it reuses the key with a different body, **Then** it is refused
   with `409 IDEMPOTENCY_KEY_REUSED`.
7. **Given** a successful create, **Then** exactly one `PO_CREATED` audit entry is
   written in the same transaction, with the actor and their capacity, the actor's name
   and email at the time, the PO number, the vendor, every line and the total, and the
   request id. **Given** a refused create, **Then** no entry is written.

---

### User Story 2 - The total can never drift (Priority: P1)

Whatever anyone tries (a crafted API body, a service-level call, raw SQL as the
application's database role, raw SQL as a privileged role), the order total always equals
the sum of its lines, and each line total always equals quantity × unit price.

**Why this priority**: This is the brief's hardest requirement (§3.3) and its "sharpest
test" (§6). Every later slice builds on the guarantee.

**Independent Test**: Run the integrity attack suite; every attempt is refused with its
specific outcome, and the reconciliation query returns zero rows afterwards.

**Acceptance Scenarios**:

1. **Given** the application's database role, **When** it tries to write an order's total,
   a line total or an order's open-line count directly, **Then** it is refused (permission
   denied).
2. **Given** a privileged database role, **When** it updates an order's total or open-line
   count directly, **Then** it gets the loud error `DERIVED_VALUE_READ_ONLY`, never a
   silent fix.
3. **Given** a draft, **When** raw SQL as the application role inserts, updates or deletes
   its lines, **Then** the order's total and open-line count follow in the same
   transaction; **When** it deletes the order's last line, **Then** the transaction is
   refused (an order always has at least one line).
4. **Given** 500 lines with fractional prices, and values at the field limits, **Then**
   the database, the server code and the API agree on the same exact total, and nothing
   overflows.
5. **Given** the attack suite has run, and after every other test suite and seed, **Then**
   the reconciliation query (line total, order total, open-line count, at least one line)
   returns zero rows.
6. **Given** an order's PO number, **When** raw SQL changes it, **Then** it is refused.

---

### User Story 3 - Edit a draft (Priority: P1)

The owner corrects a draft: changes the vendor, edits some lines, adds some and removes
others, in one save. Lines keep their identity, and the timeline shows exactly what
changed. If the draft changed meanwhile (another tab), the save is refused instead of
overwriting.

**Why this priority**: Drafts exist to be corrected before submission (ADR-0001), and line
edits are where totals drift in spreadsheets.

**Independent Test**: Edit a 3-line draft: change line 1's quantity, remove line 2, add a
new line, and move the new line first. The response shows the new order, line 1 keeps its
id, the total is the new exact sum, the version increments, and `PO_EDITED` lists one
change, one removal and one addition with field-level before → after.

**Acceptance Scenarios**:

1. **Given** a draft at version 2, **When** the owner saves the full intended line set
   with `If-Match: "2"`, **Then** lines with an id are updated, lines without one are
   added, lines left out are deleted, the array order becomes the display order, the
   total is recomputed once, and the version becomes 3.
2. **Given** a stale version, **Then** the save is refused with `409 VERSION_CONFLICT`
   and nothing changes; **given** no `If-Match`, **Then** `400` with field code
   `VERSION_REQUIRED`.
3. **Given** a line id belonging to another order, or the same id twice, **Then** the
   save is refused with `400` (`LINE_NOT_FOUND` or `DUPLICATE_LINE_ID`); **given** an
   empty line set, **Then** `400`.
4. **Given** a change to another vendor, **When** it is missing, **Then** `400
   VENDOR_NOT_FOUND`; **when** it is inactive, **Then** `409 VENDOR_INACTIVE`.
5. **Given** a successful edit, **Then** exactly one `PO_EDITED` entry records the
   header/vendor before → after and the lines added, removed and changed, field by field.
   **Given** a save that changes nothing, **Then** the version is unchanged and no entry
   is written.
6. **Given** the web app, **When** the owner saves, **Then** no confirmation is asked (a
   reversible save); leaving the editor with unsaved edits asks "Discard your unsaved
   changes?"; a `409 VERSION_CONFLICT` offers "Reload order".

---

### User Story 4 - Delete a draft (Priority: P2)

The owner deletes a draft they no longer need. It disappears, its PO number is never used
again, and the timeline keeps a record of what it contained.

**Why this priority**: Without it, abandoned drafts clutter every list. It isn't needed
to raise or correct an order.

**Independent Test**: Delete a draft through the confirmation dialog; it is gone from the
owner's list and returns `404`; an Admin reading its timeline by order id sees
`PO_DRAFT_DELETED` with the PO number and full contents; the next order gets a new number.

**Acceptance Scenarios**:

1. **Given** a draft and its current version, **When** the owner deletes it, with or
   without a reason, **Then** the order and its lines are removed, and one
   `PO_DRAFT_DELETED` entry records the PO number, the full contents and the reason if
   given.
2. **Given** a stale or missing version, **Then** `409 VERSION_CONFLICT` or `400
   VERSION_REQUIRED`, and nothing is deleted.
3. **Given** a deleted draft's PO number, **Then** no later order ever receives it.
4. **Given** the web app, **Then** deleting asks for confirmation in a dialog naming the
   PO number, vendor, line count and total, stating "This permanently deletes the
   draft" and "You won't be able to see this draft or its history again", with the safe
   choice focused.

---

### User Story 5 - Find and read orders (Priority: P1)

A Buyer opens "My orders", filters it and opens an order to see its lines, totals and
timeline. An Admin can do the same across every buyer.

**Why this priority**: §6 requires that any list of orders can be filtered without loading
every order into memory, and the timeline is the record procurement asks for in a dispute.

**Independent Test**: With two Buyers' orders seeded, Buyer A's list shows only their
orders, filtered and paginated; the Admin's list shows both; Buyer A's order shows its
lines in order and its timeline newest first.

**Acceptance Scenarios**:

1. **Given** a Buyer, **When** they list orders, **Then** they see only their own orders,
   paginated, newest first (created time, then id), with each order's PO number, vendor,
   status, line count, total and created time, but not its lines.
2. **Given** the filters of FR-016, **When** applied, **Then** the filtering runs in the database within the caller's
   visibility, and the total count matches.
3. **Given** an order the caller can read, **When** they open it, **Then** they see its
   header, vendor, lines in display order with line totals, the total, the PO number, the
   status and the version (as an `ETag`).
4. **Given** an order's timeline, **When** the owner or an Admin opens it, **Then** its
   entries are paginated, newest first, each with actor, capacity, time and details.

---

### User Story 6 - Visibility and role boundaries (Priority: P1)

Drafts are private to their owner. Admins read every order and change none. Approvers
never see drafts. Users with no role and anonymous callers get nothing.

**Why this priority**: Every action must be tied to a real user acting within their
rights (§2, §6). The ADR-0004 matrix is binding cell by cell.

**Independent Test**: Run the matrix rows for create, read draft, edit, delete, list and
timeline against owner Buyer, other Buyer, Approver, Admin, no role and anonymous.

**Acceptance Scenarios**:

1. **Given** Buyer B, **When** they read, edit, delete or open the timeline of Buyer A's
   draft, **Then** `404`; Buyer A's orders never appear in Buyer B's list.
2. **Given** an Approver, **When** they read a draft, **Then** `404`; **when** they create
   an order, **Then** `403` before the body is validated.
3. **Given** an Admin, **When** they read any draft or its timeline, **Then** it succeeds;
   **when** they create, edit or delete an order, **Then** `403`.
4. **Given** a user with no role, **Then** every order endpoint returns `403
   NO_ROLE_ASSIGNED`, even with an invalid body; **given** no session, **Then** `401`.
5. **Given** a Buyer+Approver who owns a draft, **Then** they act on it as its owner.

---

### Edge Cases

- Two edits of the same draft at the same moment with the same version: exactly one
  succeeds; the other gets `409 VERSION_CONFLICT`. An edit racing a delete: one wins; the
  other gets `409 VERSION_CONFLICT` or `404`.
- 50 concurrent creates get 50 distinct PO numbers. A failed or rolled-back create may
  leave a gap in the sequence; gaps are acceptable, never reuse.
- The first order after 1 April 00:00 IST is numbered in the new financial year, starting
  at `000001`; one at 31 March 23:59:59 IST belongs to the old one (injected database
  clock).
- A draft whose vendor was deactivated after it was raised: saving it with that vendor is
  refused with `409 VENDOR_INACTIVE`; changing it to an active vendor in the same save is
  allowed; deleting it is always allowed.
- A 500-line edit with every line changed recomputes the total once, not 500 times.
- A Buyer whose BUYER role is removed while editing: the next save is refused (`403`, or
  `403 NO_ROLE_ASSIGNED` if no role is left); their orders are kept.
- A unit price of `0` is allowed (a free item); a quantity of `0` is not.
- A description of only whitespace, or containing a control character (a line break or a
  tab included), is refused with `400`; 500 code points of four-byte characters (emoji)
  are accepted. Descriptions are stored and shown as plain text, never HTML.
- The largest valid order (500 lines, each description 500 four-byte characters) is
  accepted on create and edit: the order-write request limit fits it, and the proxy in
  front of the API has the same limit. A body over that limit → `413
  PAYLOAD_TOO_LARGE`.
- An order id that isn't a UUID → `400`; a well-formed id the caller can't read → `404`.
- A page past the last returns empty `items` with the correct `total`.
- A raw-SQL status change of a draft is refused (no transition out of `DRAFT` exists until
  slice 4); a raw-SQL delete of an order is allowed only while it is a draft.

## Requirements *(mandatory)*

### Functional Requirements

**Raising and editing**

- **FR-001** (FR-PO-01, FR-PO-02, FR-ACT-01): A Buyer MUST be able to create an order
  with a vendor and 1–500 lines (description 1–500 Unicode code points after trimming,
  single-line plain text with no control characters, quantity a whole number
  1–1,000,000, unit price 0–999,999,999.9999 with at most 4 decimal places). It is
  created in `DRAFT`, owned by the caller. Besides its lines, an order carries only its
  vendor: there are no other header fields.
- **FR-002** (FR-PO-05): Every order MUST get a PO number `PO-{FY}-{seq:06d}` at creation,
  by the Indian financial year in `Asia/Kolkata` from the database clock, restarting at 1
  each year. Numbers are unique, never reused (deleted drafts included) and never
  editable, by any path.
- **FR-003** (FR-VEN-02): Create and edit MUST refuse a missing vendor (`400`, field code
  `VENDOR_NOT_FOUND`) and an inactive one (`409 VENDOR_INACTIVE`), checked against the
  vendor locked in the same transaction (the slice 2 vendor check).
- **FR-004** (FR-PO-06): Editing a draft MUST take the full intended line set. Lines with
  an id are updated (the id must belong to the order), lines without one are added, and
  lines left out are deleted. Array order is display order. A save uses one insert, one
  update and one delete at most, whatever the line count.
- **FR-005** (NFR-CON-03): Orders MUST carry a version, returned as an `ETag`, that
  increases on every change to the order or its lines. Edit and delete MUST require
  `If-Match` (`400 VERSION_REQUIRED` if missing, `409 VERSION_CONFLICT` if stale).
- **FR-006** (NFR-CON-01): Create MUST take an `Idempotency-Key`: a replay with the same
  body returns the original result; the same key with a different body → `409
  IDEMPOTENCY_KEY_REUSED`. Keys are kept 24 hours.
- **FR-007** (FR-SM-02): The owner MUST be able to delete a draft with the current
  version and an optional reason (plain text, at most 500 characters). The order and its
  lines are removed; the PO number is not reused.
- **FR-008** (NFR-VAL-01): Every order request MUST be validated strictly before any
  business logic, per ADR-0007's order of checks. Unknown fields and the derived or
  system-assigned fields (`total`, `lineTotal`, `receivedQuantity`, `outstandingQuantity`,
  `openLineCount`, `poNumber`, `position`, `version`, `status`, owner) are refused with
  `400`. The new mutating endpoints MUST be added to the body-schema inventory.

**Derived values and integrity**

- **FR-009** (FR-PO-03, FR-PO-04): Each line total MUST be quantity × unit price, and the
  order total MUST be the sum of its line totals, maintained by the database in the same
  transaction as any line change, once per statement. The application's database role
  MUST have no write access to them, and a privileged role's direct write MUST fail with
  `DERIVED_VALUE_READ_ONLY`.
- **FR-010** (FR-RPT-03): The order's open-line count (lines not yet fully received) MUST
  be maintained by the database on line insert, update and delete from this slice on,
  guarded and reconciled like the total. Receipts, which also change it, arrive in slice 6.
- **FR-011**: An order MUST always have at least one line, enforced by the database at
  commit, so no path can leave an empty order.
- **FR-012**: The database MUST refuse line changes unless their order is a draft, a
  delete of any non-draft order, and any status change of a draft (slice 4 adds the
  submit transitions).
- **FR-013** (FR-PO-07, NFR-DATA-01): Money MUST be exact to 4 decimal places end to end:
  decimal strings in the API, a decimal type in server and web code, never a floating
  number. The web app shows amounts in INR with Indian digit grouping.
- **FR-014** (FR-PO-03, FR-PO-04): The integrity attack suite MUST try every known path
  to a mismatched total, through the API, the service layer and raw SQL, as the
  application role and as a privileged role: total, line total, open-line count or PO
  number in a body; direct `UPDATE` of derived columns; line changes without going through
  the order; deleting the last line; fractional-price drift; values at the limits. It MUST
  end with the reconciliation query returning zero rows, and the reconciliation MUST also
  run after every test suite and seed.

**Reading, lists and timelines**

- **FR-015** (FR-OWN-01, NFR-PERF-01): Order lists MUST be paginated per ADR-0007, sorted
  newest first (created time, then id), scoped in the database to what the caller can
  read (Buyer: own orders; Admin: all; Approver: non-draft only), and filterable per
  FR-016, each filter backed by an index, with no query whose count grows with page size
  or line count.
- **FR-016**: Order lists MUST offer these filters, combinable: status (one of the five
  states); vendor (by id); PO-number prefix (case-insensitive); and a created-date range
  (`from` and `to`, inclusive calendar dates in `Asia/Kolkata`, either optional, `from`
  not after `to`, otherwise `400`).
- **FR-017** (FR-OWN-01): Reading one order MUST return its vendor (id, name, status),
  owner, status, PO number, lines in display order with line totals, the total and the
  version; a caller who can't read it gets `404`.
- **FR-018** (NFR-AUD-03): The order timeline MUST be readable by the owner and Admin
  (and, from slice 4, Approvers for non-draft orders), paginated newest first. It
  survives draft deletion: after a delete, an Admin can still read it by the order's id,
  and the former owner gets `404`.
- **FR-019** (FR-OWN-01, NFR-AUTH-02): Access MUST follow ADR-0004's matrix for create,
  read, edit, delete, lists and timeline, with its check precedence. Every cell, for the
  `DRAFT` state and for anonymous callers, MUST be tested.

**Audit**

- **FR-020** (NFR-AUD-01): Create, edit and delete MUST each write exactly one audit entry
  (`PO_CREATED`, `PO_EDITED`, `PO_DRAFT_DELETED`) in the same transaction, with the
  catalogue's details (ADR-0016), the PO number and the request id. A refused or no-op
  command writes none, and a rolled-back one leaves none.

**Performance**

- **FR-021** (NFR-PERF-03): Trigger-count tests MUST show that a 500-line edit recomputes
  the total and open-line count once, and a status-only or timestamp-only update recomputes
  nothing.
- **FR-022**: Creating or replacing a 500-line order MUST meet ADR-0012's p95 of 500 ms,
  and "My orders" for the busiest buyer its 150 ms. The page and count query plans for
  every order list and the order timeline MUST be committed at ADR-0012's dataset sizes.

**Web app**

- **FR-023** (NFR-FE-01, NFR-FE-03, NFR-FE-04, NFR-FE-06, NFR-FE-09): The web app MUST
  provide "My orders" (filters in the URL, page numbers), the order editor (a virtualised
  table for up to 500 lines with row-level validation, meeting ADR-0012's editor targets),
  and order detail with the timeline. It MUST also provide the delete-draft confirmation
  dialog, the unsaved-changes guard, and "Reload order" on `VERSION_CONFLICT`. Every view
  has loading, empty and error states, errors are handled by `code`, creates send an
  `Idempotency-Key` that is reused on retry, and nothing can be sent twice by a double
  click.
- **FR-024**: The vendor-deactivation dialog MUST show how many of the caller's draft
  orders use the vendor (ADR-0018), read from the server and scoped to the caller's own
  drafts. The Admin user detail's open-order counts are not part of this slice: they
  arrive together in slice 6 (ADR-0019, amended 2026-11-12).
- **FR-025**: End-to-end tests MUST cover: a Buyer raises a multi-line order and sees the
  exact total; edits it (change, add, remove a line); a version conflict and reload;
  deletes a draft through the dialog; a second Buyer can't see it; an Admin reads it.
- **FR-026**: With demo seeding on (never in production), the seed MUST add a few draft
  orders per demo Buyer, including one with fractional prices, and the reconciliation MUST
  return zero rows after seeding.

### Key Entities

- **Purchase order**: owned by the Buyer who raised it; a PO number; a vendor reference;
  a status (`DRAFT` only in this slice); a stored total and open-line count, both derived;
  a version; created and updated times. A draft can be hard-deleted; its audit record stays.
- **Order line**: belongs to one order; description, quantity, unit price; a generated
  line total; a server-assigned position for display order; a received quantity that
  stays 0 until receipts (slice 6).
- **PO number counter**: one row per financial year holding the last number given.
- **Idempotency record**: a create's key, a fingerprint of its body and the original
  result, kept 24 hours, then purged under the maintenance role.
- **Audit entry (order)**: `PO_CREATED`, `PO_EDITED` and `PO_DRAFT_DELETED`, carrying the
  order id and PO number, and outliving deleted drafts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Buyer raises a 5-line order against an existing vendor in under 2 minutes,
  without typing or checking any total.
- **SC-002**: Zero reconciliation rows after the integrity attack suite, every other
  suite, the demo seed and the dataset seeds: in 100 % of runs, no order total differs
  from the sum of its lines.
- **SC-003**: Every attack in the integrity suite is refused with its specific outcome
  (`400`, permission denied, or `DERIVED_VALUE_READ_ONLY`); none succeeds silently.
- **SC-004**: 50 concurrent creates produce 50 distinct PO numbers; every concurrent edit
  pair ends with one success and one version conflict.
- **SC-005**: Creating or replacing a 500-line order completes within 500 ms at p95, and
  the busiest buyer's first page of orders within 150 ms at p95, at ADR-0012's production
  dataset.
- **SC-006**: Every draft-order cell of the authorization matrix (six caller kinds,
  anonymous included) is covered by a passing test.
- **SC-007**: Every successful create, edit and delete has exactly one audit entry, and
  every refused or no-op command has none, across the whole suite.
- **SC-008**: In the 500-line editor, a keystroke paints within 50 ms and adding or
  removing a line within 100 ms (p95, 4× CPU throttling); the order screens have zero
  automated accessibility violations.

## Assumptions

- **No submission yet**: submit, routing, the approval chain, the vendor snapshot and the
  approval policy endpoint arrive in slice 4; lock codes (`ORDER_LOCKED`) in slice 5;
  receipts and received quantities in slice 6; the outstanding report and load tests in
  slice 7. This slice's database rules are written so those slices add transitions
  without loosening anything.
- **Drafts show the live vendor**: a draft displays the vendor as it is now (name and
  status), so a Buyer sees a deactivated vendor before trying to submit; the snapshot is
  taken at submit (slice 4).
- **Idempotency-Key is required** on create: a create without one is refused with `400`
  (field code `REQUIRED`), so the web app's lost-response retry can't create duplicates.
- **Descriptions** are trimmed, then must be 1–500 Unicode code points with no control
  characters (Clarifications, 2026-11-12).
- **Delete reason** is optional plain text, at most 500 characters, `null` when absent,
  and `""` is refused (ADR-0007's one form for "no value").
- **Header**: an order has no header fields besides its vendor (Clarifications,
  2026-11-12).
- **Approver lists** are empty in this slice (no non-draft orders exist); their cells are
  still tested.
- **Order timeline for Admins** uses the same endpoint as for owners; the
  organisation-wide Admin log is a separate, later feature.
- **Query plans**: this slice builds the order part of the production dataset generator
  needed for its list and timeline plans (ADR-0012); receipts in that dataset arrive with
  slice 6.
- **No new error codes are expected**: `VENDOR_NOT_FOUND`, `LINE_NOT_FOUND`,
  `DUPLICATE_LINE_ID`, `READ_ONLY_FIELD`, `VERSION_REQUIRED`, `VERSION_CONFLICT`,
  `VENDOR_INACTIVE`, `IDEMPOTENCY_KEY_REUSED` and `DERIVED_VALUE_READ_ONLY` are in the
  ADRs. Planning adds any missing registry entry.
- **Infrastructure**: no new services or dependencies beyond a decimal library if the
  contracts package lacks one (an ADR-0020 addition if so).

## Dependencies

- ADR-0001, 0003, 0004, 0005, 0006, 0007, 0009, 0010, 0012, 0015, 0016 and 0018 as
  currently amended.
- Slice 0: error registry, route access declaration, audit with actor context, database
  roles, contracts, web shell. Slice 1: users and roles. Slice 2: the vendor check
  (lookup, lock, active) and vendors to order from.
- Slices 4–7 build on this slice's order and line tables, derived-value triggers,
  reconciliation query and attack suite.
