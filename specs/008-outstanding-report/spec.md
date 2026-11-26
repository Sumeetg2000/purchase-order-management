# Feature Specification: Slice 7 — Outstanding orders report, load tests and query plans

**Feature Branch**: `008-outstanding-report`

**Created**: 2026-11-26

**Status**: Draft

**Input**: User description: "Slice 7 (constitution slice order): the outstanding-orders
report, load tests and query plans. Scope: (1) the Procurement Admin's outstanding-orders
report: approved orders with open lines (and outstanding quantities), grouped by vendor
and by age, as the brief and traceability rows FR-RPT-* describe, read from the stored
open-line count and received quantities; (2) a load test at 10,000 orders, including a
pg_stat_user_indexes check that every index is used (an unused index is listed and
dropped or justified); (3) ADR-0021: the Admin order-list plans at the ADR-0012 dataset;
(4) a walkthrough document of the whole system for a new reader. Deferred, out of scope:
a separate database role for the operator CLI; running the Playwright e2e in a container.
The quickstart reuses the local driver in .local/quickstart."

## Context

Slice 6 completed the order's life: approved orders receive goods, partly or fully, and
every line's received and outstanding quantities and each order's count of open lines are
kept by the database and reconciled. What the brief's Procurement Admin still can't do is
the thing their role exists for: **see what is still outstanding, against which vendor,
and for how long** (brief §2, §3.7). The brief asks for that view as a real query whose
cost can be explained as orders accumulate (§3.7, §6, §7.3), and for a load test of
10,000 orders across 200 vendors that shows the query plan for outstanding orders by age
(§8).

This is the last slice. It also closes what earlier slices deferred to it:
- the Admin user list and access-request list plans at 10,000 users (ADR-0021, slice 1's
  SC-008), which may not stay open when this slice merges
- the walkthrough document that answers the brief's §7 questions (traceability row
  §7.1–7.3), rewritten for a reader who is new to the system

The design is already decided (ADR-0015): an order is **outstanding** when it is approved
and has at least one line not fully received; its **age** runs from approval; ages fall in
four buckets (0–30, 31–60, 61–90 and over 90 days); the report reads the order rows only,
never receipts, and reads lines only for the orders on the page shown. No outstanding
*amount* is reported (ADR-0015).

The users are:
- a **Procurement Admin**, who sees every outstanding order in the organisation, by vendor
  and age, read-only
- an **Approver**, who sees every outstanding order (all are non-draft, so all readable)
- a **Buyer**, who sees only their own outstanding orders (ADR-0004)
- a **new reader** of the system (a reviewer, a new team member), who needs one document
  that walks them through it and answers the brief's §7 questions with the code and tests
  behind each answer

Out of scope (owner decision, 2026-11-26): a separate database role for the operator CLI;
running the Playwright end-to-end suite in a container. An outstanding amount in money
(ADR-0015). Exporting the report (ADR-0019 lists what was considered and left out).

## Clarifications

### Session 2026-11-26

- Q: How should the load test raise its 10,000 orders across 200 vendors? → A: Through
  the HTTP API, with about 20 concurrent virtual users, as a plain Node script (`fetch`),
  no new load tool. Run on demand (an npm script) and nightly if that is simple; never on
  pull-request CI. One run is recorded: its duration, error counts by status, the
  outstanding report's timings on that data, then the unused-index check.
- Q: Which problems found by the load test's run should fail it, rather than be reported?
  → A: A 5xx or timeout, any reconciliation row, or an unexplained unused index fails the
  run; timings are recorded against the targets without failing. "Explained" means listed
  in a short committed list of indexes expected to be unused in this traffic, each with a
  one-line reason; any other unused index fails.
- Q: How should an order's age in days be counted for the buckets? → A: Whole calendar
  days in India time (today's India date minus the approval's India date). The report
  shows the India date its ages are as of.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See outstanding orders by vendor and age (Priority: P1)

A Procurement Admin opens the outstanding report and sees every approved order that still
has something to receive, oldest approval first, each with its PO number, vendor, owner,
approval date, age in days and age bucket, raised date, and how many of its lines are
still open. They narrow it to one vendor, to one age bucket, or both. For the orders on the
page they can see each open line's ordered, received and outstanding quantities.

**Why this priority**: This is the brief's §3.7 requirement and the Admin's whole reason to
use the system; without it the derived quantities are kept for nobody.

**Independent Test**: With approved orders in each state (nothing received, partly
received, fully received) and cancelled and rejected orders alongside, open the report as
the Admin: exactly the approved orders with an open line appear, with the right age and
bucket, and each filter narrows it correctly.

**Acceptance Scenarios**:

1. **Given** an approved order with nothing received, **When** the Admin opens the report,
   **Then** it is listed, with its vendor, owner, approval date, age, bucket, raised date
   and open-line count.
2. **Given** a listed order, **When** its owner records a receipt that leaves one line
   open, **Then** the order stays in the report with its open-line count reduced; **When**
   the receipt that completes the last open line is recorded, **Then** it leaves the
   report.
3. **Given** cancelled, rejected, pending, draft and fully received orders, **When** the
   Admin opens the report, **Then** none of them is listed, whatever it received.
4. **Given** outstanding orders approved 10, 45, 75 and 120 days ago, **When** the Admin
   filters by each bucket in turn, **Then** each bucket shows exactly the order whose age
   falls in it, and the order at exactly 30, 60 and 90 days falls in the lower bucket.
5. **Given** outstanding orders for several vendors, **When** the Admin filters by one
   vendor, **Then** only that vendor's orders appear; with a bucket as well, only that
   vendor's orders in that bucket.
6. **Given** a page of the report, **When** the Admin looks at an order on it, **Then** they
   see its open-line count and its outstanding quantity (units still to come, across its
   lines); **When** they expand the row, **Then** each line's ordered, received and
   outstanding quantities are shown, from the order's own detail.
7. **Given** more outstanding orders than fit on a page, **When** the Admin pages through,
   **Then** every outstanding order appears exactly once, in a stable order, with the total
   count shown.
8. **Given** no outstanding orders (or none matching the filters), **When** the report
   opens, **Then** it says so plainly, not as an error.

---

### User Story 2 - See the vendor summary (Priority: P1)

The Admin sees, per vendor with anything outstanding, how many orders are outstanding, how
many fall in each age bucket, and the oldest approval date, so they know which vendors to
chase first. Choosing a vendor in the summary opens the report filtered to it.

**Why this priority**: "Grouped by vendor" (brief §3.7) is the question procurement
actually asks: which vendor owes us the most, and the oldest.

**Independent Test**: With outstanding orders spread across three vendors and the four
buckets, the summary shows each vendor's counts per bucket and oldest approval exactly, and
no vendor with nothing outstanding.

**Acceptance Scenarios**:

1. **Given** outstanding orders for vendors A (3 orders) and B (1 order), and vendor C with
   only fully received orders, **When** the Admin opens the summary, **Then** A and B are
   listed with their counts per bucket and oldest approval date, and C is not.
2. **Given** the summary, **When** the Admin chooses vendor A, **Then** the report opens
   filtered to vendor A.
3. **Given** a vendor that was deactivated after its orders were approved, **When** those
   orders are still outstanding, **Then** the vendor and its orders still appear, marked
   inactive.

---

### User Story 3 - Everyone sees only what they may read (Priority: P1)

A Buyer opening the report sees only their own outstanding orders, and the summary counts
only those; an Approver sees every outstanding order; an account with no role is refused;
an anonymous caller is refused.

**Why this priority**: Every report is scoped to what the caller can read (Principle III,
ADR-0004); a report that leaked other Buyers' orders would break the brief's ownership
model.

**Independent Test**: With outstanding orders owned by two Buyers, each Buyer's report and
summary contain only their own; the Approver's and Admin's contain both.

**Acceptance Scenarios**:

1. **Given** outstanding orders owned by Buyer One and Buyer Two, **When** Buyer One opens
   the report and the summary, **Then** only Buyer One's orders are listed and counted.
2. **Given** the same orders, **When** an Approver or the Admin opens them, **Then** both
   Buyers' orders are listed and counted.
3. **Given** an account with no role, **When** it asks for the report, **Then** it is
   refused with `403 NO_ROLE_ASSIGNED`; an anonymous caller gets `401`.
4. **Given** a Buyer+Approver, **When** they open the report, **Then** they see every
   outstanding order (as an Approver), their own included.

---

### User Story 4 - The 10,000-order load test proves the query and finds idle indexes (Priority: P2)

The team runs one command that raises 10,000 orders across 200 vendors with varying
receipt histories, measures the report, the vendor summary and the other lists against
their targets, commits the query plan for outstanding orders by age, and lists every
index that the workload never used, so each one is either dropped or justified.

**Why this priority**: The brief's §8 asks for exactly this load test and plan; the
unused-index check turns "every index earns its place" into something proven, not
assumed.

**Independent Test**: Run the load test from an empty database: it finishes with the
targets met, the plan for outstanding-orders-by-age committed and using the report's
index, reconciliation at zero rows, and an unused-index list that is empty or fully
justified.

**Acceptance Scenarios**:

1. **Given** an empty database, **When** the load test runs, **Then** it raises 10,000
   orders across 200 vendors, approves them, records receipts so some are untouched, some
   partly and some fully received, and cancels or rejects some, as the system's own rules
   allow.
2. **Given** that dataset, **When** the report and summary are measured, **Then** their
   95th percentile response times meet the targets in ADR-0012 (report 200 ms, vendor
   summary 300 ms).
3. **Given** that dataset, **When** the plan for outstanding orders by age is taken,
   **Then** it uses the report's index on approved, still-open orders and reads no
   receipts and no lines beyond the page, for the page and for its count.
4. **Given** the load test's workload (which also makes every read the UI offers once),
   **When** index usage is read on the load stack,
   **Then** every index that was never used is listed, and the run fails unless each one is
   in the committed list of indexes expected to be unused in this traffic, with its
   one-line reason (for example, it backs a constraint), or is dropped.
5. **Given** a request answered 5xx or timing out during the run, **When** the run ends,
   **Then** it fails, with the error counts by status; a report timing above its target
   is recorded against the target but does not fail the run.
6. **Given** the load test ended, **When** reconciliation runs, **Then** it returns zero
   rows, or the run fails.

---

### User Story 5 - The Admin's user lists are proven at 10,000 users (Priority: P2)

The Admin user list and the access-request list are measured and planned at 10,000 users,
as slice 1 deferred (ADR-0021).

**Why this priority**: ADR-0021 is an open deviation that this slice must close before it
merges.

**Independent Test**: On a 10,000-user dataset across every status and role set, the
first page of each list (and its count) answers under 200 ms, and its committed plan
reads no table end to end.

**Acceptance Scenarios**:

1. **Given** 10,000 users across every status and role set, **When** the Admin's user list
   first page is taken, **Then** it answers within 200 ms and its committed plan, page and
   count, uses an index, with no full table scan.
2. **Given** the same users with pending access requests, **When** the access-request list
   is taken, **Then** the same holds.
3. **Given** the plans committed, **When** a change makes either list scan its table,
   **Then** the plan test fails.

---

### User Story 6 - A new reader can walk through the system (Priority: P3)

A reviewer or new team member reads one document that walks them through the system: what
it does, who uses it, how an order moves from draft to received, where each guarantee
lives (database, service, API, screen), and the answers to the brief's §7 questions, each
pointing at the code and tests that back it.

**Why this priority**: The brief ends in a walkthrough (§7); the answers exist only as an
early draft written before most of the code.

**Independent Test**: A reader follows each §7 answer to the files and tests it names, and
every named path exists and says what the answer claims.

**Acceptance Scenarios**:

1. **Given** the document, **When** a reader follows any file or test it names, **Then**
   that file or test exists at that path.
2. **Given** §7.3, **When** the reader looks for the plan it cites, **Then** the committed
   plan for outstanding orders by age is there and shows what the answer says it touches.

---

### Edge Cases

- An order approved today has age 0 and is in the 0–30 bucket.
- Ages count whole calendar days in India time (the business's time zone, as receipt dates
  do), so an order approved at 23:50 India time is a day old ten minutes later; the
  report shows the India date its ages are as of.
- An order whose last open line is completed while the Admin has the page open: the next
  load no longer lists it; nothing goes stale beyond the page already shown.
- A cancelled order that received part of its goods is not outstanding: nothing more will
  arrive against it.
- An approved order with every line fully received is not outstanding, even though it is
  still `APPROVED`.
- A vendor renamed after approval: the report and summary show its current name; the
  order's own detail still shows the vendor as submitted.
- A vendor filter naming a vendor that doesn't exist, or with nothing outstanding: an
  empty report, not an error. A filter value that isn't valid (an unknown bucket, a
  malformed vendor id): `400` naming the field.
- A page past the last: an empty page with the true total.
- A Buyer who is deactivated: their outstanding orders stay in the Admin's and Approvers'
  report (the obligation to the vendor remains).
- The unused-index check on an index that backs a uniqueness or foreign-key rule: it is
  justified by that rule, not dropped.

## Requirements *(mandatory)*

### Functional Requirements

**Outstanding report** (brief §3.7, §6; ADR-0015, ADR-0004)

- **FR-001** (FR-RPT-01): The system MUST provide a report of outstanding orders: approved
  orders with at least one line not fully received. Cancelled, rejected, pending, draft
  and fully received orders MUST NOT appear.
- **FR-002** (FR-RPT-01): Each listed order MUST show its PO number, vendor (name and
  whether active), owner, approval date, age in whole days since approval, age bucket
  (0–30, 31–60, 61–90, over 90 days), raised date and number of open lines.
- **FR-002a** (FR-RPT-01): Age MUST be whole calendar days in India time: the India date
  the report is taken on minus the order's approval India date. The report and the
  summary MUST show that as-of India date.
- **FR-003** (FR-RPT-01): The report MUST be filterable by vendor and by age bucket, alone
  or together, and MUST be paginated with a total count, oldest approval first, in a
  stable order.
- **FR-004** (FR-RPT-01): Each report row MUST carry summary numbers only: its open-line
  count and its outstanding quantity (the sum of ordered minus received over its lines),
  computed for the page's rows only. Expanding a row MUST show each line's ordered,
  received and outstanding quantities from the existing order detail read, which the
  caller can already read (owner decision, 2026-11-26).
- **FR-005** (FR-RPT-01): The system MUST provide a vendor summary: per vendor with any
  outstanding order, the number of outstanding orders, the number in each age bucket and
  the oldest approval date, scoped like the report.
- **FR-006** (FR-RPT-01, FR-OWN-01): The report and summary MUST be scoped to what
  the caller can read (ADR-0004): a Buyer sees only their own orders; an Approver and the
  Admin see all; a no-role account gets `403 NO_ROLE_ASSIGNED`; an anonymous caller `401`.
- **FR-007** (FR-RPT-03): Whether an order is outstanding MUST be decided from the stored,
  database-maintained open-line count (INV-6), and each line's outstanding quantity from
  its stored received quantity (INV-3, INV-4); the report MUST NOT recompute either from
  receipts.
- **FR-008** (FR-RPT-01): A receipt that completes an order's last open line MUST remove
  the order from the report and the summary at once; a partial receipt MUST keep it, with
  its open-line count updated.
- **FR-009**: Invalid filters MUST be refused with `400` naming the field, before any
  business logic (ADR-0007).
- **FR-010**: The web app MUST offer the report and the vendor summary to every role that
  may read them, with loading, empty and error states, filters kept in the address so
  Back, Forward and a shared link show the same view, and no automated accessibility
  violation (ADR-0018).

**Query cost** (brief §3.7, §6, §7.3, §8; ADR-0012, ADR-0015)

- **FR-011** (FR-RPT-02): The report page and its count, and the vendor summary, MUST each
  be answered by bounded, indexed queries that read the outstanding orders' rows (and
  vendor names), lines only for the page shown, and never receipts.
- **FR-012** (FR-RPT-02, NFR-PERF-01): The plans for the report (page and count, with and
  without each filter, for an Admin and for a Buyer) and the vendor summary MUST be
  committed at the ADR-0012 datasets, with a test that fails if a plan reads receipts,
  scans lines beyond the page, or scans the orders table end to end; page 100 is measured
  and recorded with no target.

**Load test** (brief §8; ADR-0012)

- **FR-013** (NFR-PERF-02): A load test MUST raise 10,000 orders across 200 vendors with
  varying receipt histories (untouched, partly and fully received, and some cancelled and
  rejected) through the HTTP API, with about 20 concurrent virtual users, so every state
  is reached by the system's own rules. It is a plain script with no new load tool, run on
  demand and nightly if that is simple, never on pull-request CI.
- **FR-014** (NFR-PERF-02): The load test MUST commit the query plan for outstanding orders
  by age on its dataset, and MUST end with reconciliation at zero rows.
- **FR-015** (NFR-PERF-04): The load test MUST record one run: its duration, its error
  counts by HTTP status, and the outstanding report's and vendor summary's timings on that
  data, against ADR-0012's p95 targets, then the unused-index check.
- **FR-016**: After the load test's workload, which also makes every read the UI offers
  once, the load stack's index usage
  MUST be read, and every index never used MUST be listed; the check MUST fail on any
  listed index that is not in a short committed list of indexes expected to be unused in
  this traffic, each with a one-line reason (such as backing a uniqueness or foreign-key
  rule). An index that is neither used nor justified is dropped.
- **FR-016a**: The load test's run MUST fail on any 5xx response or timeout, or any
  reconciliation row, or an unexplained unused index; timings over their targets are
  recorded against the targets without failing the run.

**Admin list plans** (ADR-0021, ADR-0012, slice 1 SC-008)

- **FR-017**: The Admin user list and access-request list MUST have committed plans, page
  and count, at 10,000 users across every status and role set, with a test that fails on
  a full table scan; their first pages MUST answer within 200 ms. ADR-0021 MUST be closed.

**Walkthrough** (brief §7; traceability §7.1–7.3)

- **FR-018**: The walkthrough document MUST walk a new reader through the system (purpose,
  users, an order's life from draft to received, where each guarantee is enforced) and
  answer each §7 question, naming the code, tests and committed plans behind each answer.
- **FR-019**: A check MUST fail when the walkthrough names a file or test that does not
  exist.

### Key Entities

- **Outstanding order** (a view, not stored): an approved order whose open-line count is
  above zero; with its vendor, owner, approval and raised dates, age and bucket.
- **Age bucket**: one of 0–30, 31–60, 61–90 and over 90 days since approval, in India
  time.
- **Vendor summary row**: per vendor, outstanding-order count, count per bucket and oldest
  approval date, within the caller's scope.
- **Open line**: a line of an outstanding order whose received quantity is below its
  ordered quantity; its outstanding quantity is ordered minus received. An order's
  outstanding quantity is the sum over its lines.
- **Load-test dataset**: 10,000 orders across 200 vendors with varying receipt histories,
  built by the system's own rules.
- **Index-usage finding**: an index the workload never used, with its outcome (dropped, or
  kept with a recorded reason).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On the 100,000-order dataset, the report's first page answers within 200 ms
  and the vendor summary within 300 ms, at the 95th percentile.
- **SC-002**: On the 10,000-order, 200-vendor load-test dataset, the report's and
  summary's timings are recorded against the same targets, no request fails with a 5xx or
  times out, and reconciliation returns zero rows after the run.
- **SC-003**: Every report and summary plan is committed and none reads receipts; the
  outstanding-orders-by-age plan is committed for the load-test dataset.
- **SC-004**: An Admin can find every outstanding order for a given vendor older than 60
  days in under 30 seconds from opening the report.
- **SC-005**: Every index is either used by the workload or recorded with the reason it
  stays; none is left unexplained.
- **SC-006**: The Admin user list's and access-request list's first pages answer within
  200 ms at 10,000 users, and ADR-0021 is closed.
- **SC-007**: Every file and test the walkthrough names exists; every §7 question has an
  answer that points at code, tests and plans.
- **SC-008**: The report and summary screens have no automated accessibility violations.

## Assumptions

- **Definitions are ADR-0015's**: outstanding = approved with an open line; age from
  approval; four buckets; no amount. Ages are whole calendar days in India time,
  matching receipt dates (slice 6), as of the India date shown (clarified 2026-11-26).
- **Order**: oldest approval first, then a stable tie-break, so the most overdue orders
  lead.
- **Vendor name**: the vendor's current name, with its active status, as the summary
  groups by vendor rather than by the name as submitted.
- **Load test** (clarified 2026-11-26): through the HTTP API, about 20 virtual users, a
  plain Node script; on demand and nightly if simple; never on pull-request CI; one run
  recorded. ADR-0012's load-job wording (50 virtual users for 10 minutes, median of 3
  runs) is updated to match at plan time.
- **Index check workload**: the load test's requests, including one of every read the UI
  offers, on the load stack (the plan suite runs on its own databases); an
  index that backs a constraint counts as justified.
- **Admin lists**: the 10,000-user dataset is the one ADR-0012 records, built by a
  fixed-seed generator.
- **Walkthrough**: `docs/walkthrough.md` is rewritten in place, not a new file.
- **Quickstart**: the slice's quickstart run reuses the local driver in
  `.local/quickstart/` (not committed).

## Dependencies

- Slice 6's stored received quantities and open-line count (INV-3, INV-6), guarded and
  reconciled.
- ADR-0015 (report design), ADR-0012 (datasets and targets), ADR-0004 (who reads what),
  ADR-0021 (the deviation this slice closes), ADR-0018 (screens).
- The plan tooling and 100,000-order fixture of slices 3–6.
