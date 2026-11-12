# Feature Specification: Slice 2 — Vendors

**Feature Branch**: `003-vendors`

**Created**: 2026-11-06

**Status**: Draft

**Input**: User description: "Slice 2: Vendors. From the brief §3.1 Vendor management:
'Maintain a vendor list with contact details and payment terms (e.g. net 30). A purchase
order must reference a real vendor; you cannot raise an order against a vendor that
doesn't exist or has been deactivated.' Actors (§2): the Buyer maintains vendors.
Requirements in scope per docs/traceability.md: FR-VEN-01, the vendor rows of FR-ACT-01,
and the vendor-history part of NFR-AUD-03. FR-VEN-02 and FR-VEN-03 belong to the order
slices, but this slice must provide the vendor lookup and active check they will use.
Mechanisms per ADR-0005, ADR-0004, ADR-0007, ADR-0016, ADR-0018. Short name: vendors."

## Context

Today purchase orders are raised in spreadsheets against vendors typed by hand, so the
same vendor appears under several spellings and nobody knows which payment terms apply
(brief §1). This slice delivers the one shared vendor list every order will reference: who
the vendor is, how to reach them, and how they are paid. It delivers no order feature;
orders arrive in slice 3 and use the lookup and active check built here.

The users are:
- a **Buyer**, who adds vendors, corrects their details and payment terms, and
  deactivates vendors the company no longer uses (or reactivates them)
- an **Approver** or **Procurement Admin**, who reads vendors (Admins also read vendor
  history)

The binding documents are the [constitution](../../.specify/memory/constitution.md), the
ADRs in [docs/adr/](../../docs/adr/README.md) and [docs/BRIEF.md](../../docs/BRIEF.md).
This spec states *what* must be true; ADR-0005 (vendors), ADR-0004 (authorization
matrix), ADR-0006 (versioned updates), ADR-0007 (API conventions and error registry),
ADR-0016 (audit) and ADR-0018 (frontend) record the mechanisms and numbers.

Traceability: §2 → FR-ACT-01 (vendor rows); §3.1 → FR-VEN-01, and the building block for
FR-VEN-02; §6 → NFR-AUD-03 (vendor history), NFR-VAL-01 (vendor inputs).

## Clarifications

### Session 2026-11-06

- Q: Which contact details does a vendor carry? → A: One contact person: `contactName`
  (required, 1–200), `contactEmail` (required, valid email, stored lower-cased),
  `contactPhone` (optional; digits, spaces and `+ - ( )`, length-limited). No address:
  the brief has no use for one.
- Q: May a vendor contact's email and phone appear in vendor audit entries' before →
  after? → A: Yes. Vendor contact details are business data, kept in full in vendor
  audit entries; the exception is recorded in an ADR-0016 update (2026-11-06). Principle
  IV still applies to users' personal data.
- Q: Which vendors does the list show by default? → A: Active only (`status=ACTIVE`);
  `INACTIVE` and `ALL` are filter choices (owner override; uppercase like slice 1's
  filters).
- Q: What does a duplicate-name refusal tell the caller? → A: `409
  DUPLICATE_VENDOR_NAME` includes the existing vendor's id and name, so the UI can link to
  it; this also covers a retried create (owner override).
- Q: Are the remaining defaults kept (repeat deactivate/reactivate → `409
  INVALID_STATE_TRANSITION`; inactive vendors editable; `If-Match` on changes, no
  `Idempotency-Key` on create; deactivate dialog's draft count added in slice 3; names
  1–200 characters)? → A: Yes, all kept.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Add a vendor and find it again (Priority: P1)

A Buyer adds a vendor with its name, contact details and payment terms, then finds it in
the shared vendor list. Another Buyer sees and uses the same vendor; nobody keeps a
private copy.

**Why this priority**: Without a vendor nothing else in the system can start: every order
must reference one (§3.1).

**Independent Test**: Log in as Buyer A, create a vendor with NET 30 terms; log in as
Buyer B and find it in the list by name, filtered to active vendors.

**Acceptance Scenarios**:

1. **Given** a Buyer, **When** they create a vendor with a name, contact details and NET
   terms of 30 days, **Then** it is saved as active, returned with its id and version,
   and appears in every Buyer's vendor list.
2. **Given** a vendor "Acme Supplies", **When** any Buyer creates "  acme   SUPPLIES ",
   **Then** it is refused with `409 DUPLICATE_VENDOR_NAME`, whether the existing vendor
   is active or inactive, and the refusal carries the existing vendor's id and name so
   the web app can link to it.
3. **Given** each payment-term type, **When** a Buyer creates a vendor with NET (0–180
   days), ADVANCE (no further fields) or PARTIAL_ADVANCE (1–99 % advance plus 0–180 days
   for the balance), **Then** it is accepted; **When** the days or percentage are out of
   range, a field required by the type is missing, or a field the type doesn't use is
   sent, **Then** it is refused with `400 VALIDATION_FAILED` naming the field.
4. **Given** a request with an unknown field, a system-assigned field (id, status,
   version, timestamps) or malformed JSON, **When** it is sent, **Then** it is refused
   with `400` before any business rule runs.
5. **Given** many vendors, **When** any reader lists them, **Then** results are paginated,
   sorted by name then id, showing active vendors by default (`status=ACTIVE`), with `INACTIVE`
   and `ALL` as filter choices, and a case-insensitive name prefix filter.

---

### User Story 2 - Correct a vendor's details (Priority: P1)

A Buyer fixes a vendor's contact details or changes its payment terms. If someone else
changed the vendor meanwhile, the Buyer is told instead of silently overwriting.

**Why this priority**: Wrong contacts or terms on the shared list mislead every buyer, and
lost updates on shared data are exactly the drift the system exists to stop.

**Independent Test**: Two Buyers open the same vendor; the first saves; the second's save
with the old version is refused with `409 VERSION_CONFLICT`.

**Acceptance Scenarios**:

1. **Given** a vendor at version 3, **When** a Buyer edits it with that version, **Then**
   the change is saved and the version becomes 4.
2. **Given** a vendor at version 4, **When** a Buyer edits it with version 3, **Then** it
   is refused with `409 VERSION_CONFLICT` and nothing changes; **When** no version is
   sent, **Then** it is refused with `400` and field code `VERSION_REQUIRED`.
3. **Given** a rename to a name that normalises to another vendor's name, **When** saved,
   **Then** it is refused with `409 DUPLICATE_VENDOR_NAME`; changing only the case or
   spacing of the vendor's own name is allowed.
4. **Given** an inactive vendor, **When** a Buyer edits its details, **Then** the edit is
   allowed (details can be fixed before reactivation).
5. **Given** an edit, **Then** the web form asks for no confirmation (a reversible save),
   but leaving the form with unsaved edits asks "Discard your unsaved changes?".

---

### User Story 3 - Deactivate and reactivate a vendor (Priority: P1)

A Buyer deactivates a vendor the company stops using, so no new order can be raised
against it. Nothing is ever deleted; the vendor can be reactivated later.

**Why this priority**: The brief forbids raising orders against a deactivated vendor
(§3.1), and deactivation replaces deletion so history stays intact.

**Independent Test**: Deactivate a vendor; confirm it drops out of the active filter, the
order-side active check reports it inactive, and reactivation restores it.

**Acceptance Scenarios**:

1. **Given** an active vendor, **When** a Buyer deactivates it with the current version,
   **Then** it becomes inactive, the version increments, it leaves the default (active)
   list, and it still appears under the `INACTIVE` and `ALL` filters and by direct lookup.
2. **Given** an inactive vendor, **When** a Buyer reactivates it, **Then** it becomes
   active again with no confirmation dialog.
3. **Given** the web app, **When** a Buyer deactivates a vendor, **Then** a confirmation
   dialog names the vendor and states "Orders using it can't be submitted or approved
   until it's reactivated", with the safe choice focused.
4. **Given** any vendor, **When** anyone tries to delete it, **Then** there is no way to
   do so (no endpoint, and the database refuses deletes by the application role).
5. **Given** the order-side check provided by this slice, **When** it is asked about a
   missing vendor id, **Then** it reports `VENDOR_NOT_FOUND` (a `400` field code);
   **When** asked about an inactive vendor, **Then** it reports `409 VENDOR_INACTIVE`;
   when asked about an active one, it locks the vendor row in the documented lock order
   and returns it.

---

### User Story 4 - Role boundaries on vendors (Priority: P1)

Only Buyers change vendors. Approvers and Admins read them; users with no role and
anonymous callers can't.

**Why this priority**: Every action must be tied to a real user with the right role
(§2, §6), and the matrix in ADR-0004 is binding cell by cell.

**Independent Test**: Run the authorization matrix rows for vendors against every role,
no role, and anonymous.

**Acceptance Scenarios**:

1. **Given** an Approver or Admin, **When** they list or read vendors, **Then** it
   succeeds; **When** they create, edit, deactivate or reactivate one, **Then** it is
   refused with `403` before the body is validated.
2. **Given** a user with no role, **When** they call any vendor endpoint, **Then** it is
   refused with `403 NO_ROLE_ASSIGNED`; an anonymous caller gets `401`.
3. **Given** the web app, **When** an Approver or Admin opens the vendors screen, **Then**
   it is read-only (no add, edit, deactivate or reactivate controls).

---

### User Story 5 - Vendor history (Priority: P2)

A Buyer or Admin opens a vendor's history to see who created it, who changed what, and
who deactivated or reactivated it, and when.

**Why this priority**: Disputes over which payment terms applied need the record (§6),
but it adds no capability the order slices depend on.

**Independent Test**: Create, edit, deactivate and reactivate a vendor; its history shows
four entries, newest first, each with actor, time and before → after.

**Acceptance Scenarios**:

1. **Given** a create, edit, deactivate or reactivate, **Then** exactly one audit entry
   (`VENDOR_CREATED`, `VENDOR_UPDATED`, `VENDOR_DEACTIVATED`, `VENDOR_REACTIVATED`) is
   written in the same transaction, with the actor, their capacity, a snapshot of their
   name and email, before → after and the request id.
2. **Given** a refused change (validation, duplicate, version conflict, role), **Then** no
   audit entry is written and nothing changes.
3. **Given** a Buyer or Admin, **When** they read a vendor's history, **Then** it is
   paginated newest first; **given** an Approver, **Then** it is refused with `403`.
4. **Given** a user renamed after acting, **Then** past history entries still show the
   name they had at the time.

---

### Edge Cases

- Names that differ only in case, leading/trailing or repeated internal whitespace are the
  same name; names differing in any other character are distinct.
- An empty or whitespace-only name is refused with `400`.
- Two Buyers create the same normalised name at the same moment: exactly one succeeds,
  the other gets `409 DUPLICATE_VENDOR_NAME` naming the winner, never `500`. A retried
  create (lost response) gets the same `409`, pointing at the vendor it already created.
- `contactEmail` is compared and stored lower-cased; an invalid email → `400`. A
  `contactPhone` with letters or other symbols, or over the length limit → `400`; an
  omitted or `null` phone is stored as no phone (`null`); `""` is refused with `400`, never
  stored (ADR-0007: one form for "no value"). Contact emails need not be unique.
- Two Buyers deactivate and edit the same vendor at the same moment: one wins, the other
  gets `409 VERSION_CONFLICT`.
- Deactivating an already-inactive vendor, or reactivating an active one, is refused with
  `409 INVALID_STATE_TRANSITION`, writes no audit entry and leaves the version unchanged.
- A role is removed from a Buyer while their vendor form is open: the next save is refused
  with `403` (roles are loaded on every request).
- A vendor id that isn't a UUID → `400`; a well-formed id that doesn't exist → `404` on
  the vendor endpoints (it is the `400 VENDOR_NOT_FOUND` field code only when it is a
  reference inside an order).
- A page number past the last page returns an empty `items` with the correct `total`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** (FR-VEN-01): The system MUST keep one shared vendor list. Every Buyer MUST be
  able to create, edit, deactivate and reactivate any vendor; there is no vendor owner.
- **FR-002** (FR-VEN-01): A vendor MUST have a name, one contact person and payment
  terms. Contact: `contactName` (required, 1–200 characters after trimming),
  `contactEmail` (required, a valid email of at most 254 characters, stored lower-cased)
  and `contactPhone` (optional; only digits, spaces and `+ - ( )`, at least one digit, at
  most 30 characters). There is no address.
- **FR-003** (FR-VEN-01): Payment terms MUST be exactly one of NET (`netDays` 0–180),
  ADVANCE (100 % upfront, no further fields) or PARTIAL_ADVANCE (`advancePercent` 1–99
  and `netDays` 0–180 for the balance), validated by schema per ADR-0005.
- **FR-004** (FR-VEN-01): Vendor names MUST be unique across active and inactive vendors
  after normalisation (trimmed, internal whitespace collapsed, case-insensitive),
  enforced by the database so concurrent creates can't both succeed; a clash returns
  `409 DUPLICATE_VENDOR_NAME`, whose body includes the existing vendor's id and name.
  The name is stored as entered (trimmed).
- **FR-005** (FR-VEN-01): Vendors MUST never be deleted: there is no delete endpoint and
  the application's database role can't delete vendor rows.
- **FR-006**: Vendors MUST carry an integer version returned as an `ETag`. Edit,
  deactivate and reactivate MUST require `If-Match` (`400 VERSION_REQUIRED` if missing,
  `409 VERSION_CONFLICT` if stale), per ADR-0006.
- **FR-007**: Deactivate and reactivate MUST be separate actions from editing, each valid
  only from the opposite state (`409 INVALID_STATE_TRANSITION` otherwise).
- **FR-008** (NFR-VAL-01): Every vendor request body MUST be strictly validated before
  any business logic: unknown, system-assigned or type-irrelevant fields are refused with
  `400`. The new mutating endpoints MUST be added to the reviewed body-schema inventory.
- **FR-009**: Vendors MUST be listable by any role holder: paginated per ADR-0007, sorted
  by name then id, filterable by status (`ACTIVE`, `INACTIVE` or `ALL`, default `ACTIVE`;
  `ALL` is a filter value only) and by a
  case-insensitive name prefix, each filter backed by an index with a committed query
  plan, page and count.
- **FR-010** (FR-ACT-01): Access MUST follow ADR-0004's vendor rows: Buyer read and
  write; Approver and Admin read only (`403` on writes, before validation); no role
  `403 NO_ROLE_ASSIGNED`; anonymous `401`. Every cell MUST be tested.
- **FR-011** (FR-VEN-02, building block): The system MUST provide an internal vendor
  check for the order slices that, inside the caller's transaction, resolves a vendor id
  and locks it (after the order and its lines, per ADR-0006's lock order), reporting
  `VENDOR_NOT_FOUND` for a missing id and `VENDOR_INACTIVE` for an inactive vendor. It
  MUST be tested in this slice directly, without orders.
- **FR-012** (FR-VEN-03, building block): The vendor's name, contact details and payment
  terms MUST be readable as one snapshot value the order slices can store on submit.
- **FR-013** (NFR-AUD-03): Create, edit, deactivate and reactivate MUST each write one
  audit entry (`VENDOR_CREATED`, `VENDOR_UPDATED`, `VENDOR_DEACTIVATED`,
  `VENDOR_REACTIVATED`) in the same transaction, with the full vendor before → after,
  contact name, email and phone included (ADR-0016, amended 2026-11-06: vendor contact
  details are business data). User personal data stays excluded per Principle IV.
- **FR-014** (NFR-AUD-03): Buyers and Admins MUST be able to read a vendor's history,
  paginated newest first (`occurredAt`, then id); Approvers get `403`.
- **FR-015**: Every new error code MUST be in the single error registry; this slice uses
  existing codes (`DUPLICATE_VENDOR_NAME`, `VENDOR_INACTIVE`, `VENDOR_NOT_FOUND`,
  `VERSION_CONFLICT`, `VERSION_REQUIRED`, `INVALID_STATE_TRANSITION`) and adds none
  unless planning finds a gap.
- **FR-016** (NFR-FE-09): The web app MUST provide the vendors screen of ADR-0018: list
  with filters and pagination, create and edit form (no confirmation on save,
  unsaved-changes guard), deactivate with the confirmation dialog, reactivate without
  one, and vendor history for Buyers and Admins; read-only for Approvers and Admins.
  Every view has loading, empty and error states, and errors are handled by `code`.
- **FR-017**: End-to-end tests MUST cover: a Buyer creates a vendor and a second Buyer
  sees it; edit with a version conflict and reload; deactivate through the dialog and
  reactivate; an Approver sees a read-only list.
- **FR-018**: With demo seeding on (never in production), the seed MUST create a handful
  of vendors covering each payment-term type and one inactive vendor.

### Key Entities

- **Vendor**: a company the organisation buys from. Name (unique after normalisation),
  one contact person (name, email, optional phone), payment terms, `ACTIVE`/`INACTIVE` status, version, created/updated
  timestamps. Never deleted. Referenced by orders from slice 3.
- **Payment terms**: a structured value of one of three types (NET, ADVANCE,
  PARTIAL_ADVANCE) with the type's fields; part of the vendor and of the order's vendor
  snapshot.
- **Vendor snapshot**: name, contact details and payment terms as one value, copied onto
  an order at submit (slice 4) so later vendor edits never change a locked order.
- **Audit entry (vendor)**: an append-only record of a vendor change with actor, capacity,
  actor name/email snapshot, before → after and request id.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Buyer adds a new vendor with contacts and terms in under 1 minute, and a
  second Buyer finds it by typing the first few letters of its name.
- **SC-002**: 100 % of duplicate-name attempts (case, spacing, concurrent creates) are
  refused; the vendor list never holds two vendors with the same normalised name.
- **SC-003**: Zero lost updates: every concurrent edit pair in the test suite ends with
  one success and one version conflict.
- **SC-004**: Every vendor row of the authorization matrix (each role, no role,
  anonymous) is covered by a passing test.
- **SC-005**: Every successful vendor change has exactly one history entry, and every
  refused one has none, across the whole test suite.
- **SC-006**: At the ADR-0012 dataset sizes (2,000 vendors, about 2M audit entries), the
  committed plans for every vendor list and history page read through an index, with no
  sequential scan of the vendor or audit table and no sort of more rows than the page
  needs; each page and count plan is committed.
- **SC-007**: The vendors screen and its dialog have zero automated accessibility
  violations.

## Assumptions

- **Deactivation dialog draft count**: ADR-0018's dialog shows how many of the caller's
  draft orders use the vendor. Orders don't exist yet, so the orders slice adds that
  count (an additive response field), as slice 1 did for the admin user detail; this
  slice's dialog shows the vendor and the consequence only.
- **Name length**: 1–200 characters after trimming; Unicode normalised (NFC) before the
  uniqueness comparison.
- **Idempotency**: vendor creates take no `Idempotency-Key` (ADR-0006 names orders and
  receipts); a retried create is caught by name uniqueness, and the `409` names the
  vendor already created.
- **Contact phone limit**: at most 30 characters with at least one digit, enough for an
  international number with formatting.
- **Duplicate-name details**: the existing vendor's id and name ride in the `409` problem
  body as an extension member; planning records it in the contract (ADR-0007).
- **Vendor summary and outstanding report**: the per-vendor outstanding summary (ADR-0015,
  ADR-0012's 300 ms target) arrives in slice 7.
- **Order-side rules** (refusing create/edit/submit/approve on an inactive vendor; receipt
  and cancel still allowed after deactivation; the snapshot on submit) are tested in the
  slices that add those actions, using FR-011 and FR-012.
- **Organisation-wide audit log**: vendor entries are written here; the Admin log screen
  that filters by vendor arrives with the audit log.
- **Infrastructure**: no new services or dependencies.

## Dependencies

- ADR-0004, ADR-0005, ADR-0006, ADR-0007, ADR-0016 and ADR-0018 as currently amended.
- Slice 0: error registry, route access declaration, audit trail with actor context, DB
  roles, contracts and the web shell. Slice 1: authenticated users and roles.
- Slices 3–7 depend on this slice's vendor table, active check (FR-011) and snapshot
  (FR-012).
