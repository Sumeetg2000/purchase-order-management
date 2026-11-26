# Research: Slice 7 — Outstanding orders report, load tests and query plans

Decisions for [spec.md](spec.md). Each: decision, rationale, alternatives. Items marked
**[sign-off]** change an ADR's recorded mechanism or number and wait for the owner (R12).

## R1. Report endpoints and response shape

**Decision**: two read operations, both `access: 'role'`, roles Buyer, Approver, Admin
(ADR-0004's existing row "Outstanding report and order lists"):
- `GET /api/reports/outstanding` (`listOutstandingOrders`): query = page, pageSize,
  optional `vendorId`, optional `ageBucket`; response = the usual page envelope plus
  `asOf` (the India date ages are counted to). Each item: order id, PO number, vendor
  (id, name, status), owner (id, name), `approvedAt`, `approvedOn` (India date),
  `createdAt`, `ageDays`, `ageBucket`, `lineCount`, `openLineCount` and
  `outstandingQuantity` (Σ ordered − received over its lines), oldest approval first,
  then order id (a stable tie-break that is the index's own order).
- `GET /api/reports/outstanding/vendors` (`listOutstandingVendors`): query = page,
  pageSize; response = page envelope plus `asOf`. Each item: vendor (id, name, status),
  `orderCount`, `byBucket` (count per bucket, all four keys present), `oldestApprovedOn`;
  oldest approval first, then vendor name, then id.

**Rationale**: separate list and summary match the two questions procurement asks (which
orders, which vendors) and keep each query's plan simple. `asOf` makes ages reproducible
from the response (clarified 2026-11-26).

**Alternatives**: one endpoint with a `groupBy` switch (two response shapes behind one
operation, harder to type and plan); report under `/orders?outstanding=true` (the
order-list scopes and indexes don't fit the approval-age order).

## R2. Scope

**Decision**: a caller with only the Buyer role sees their own outstanding orders; any
caller holding Approver or Admin sees all (every outstanding order is non-draft, so all
are readable to an Approver, ADR-0004). A Buyer+Approver therefore sees all, their own
included (spec US3 scenario 4).

**Rationale**: reuses ADR-0004 exactly; the order list's four-way scope collapses to two
because drafts can't be outstanding.

## R3. Age, buckets and the as-of date

**Decision**: the service takes today's India date `D` from the injected clock; age =
`D − approvedOn` in whole days (clarified 2026-11-26). Buckets `DAYS_0_30`,
`DAYS_31_60`, `DAYS_61_90`, `OVER_90` are filtered as `approved_at` ranges whose bounds
are India midnights: `start(d) = (d::timestamp AT TIME ZONE 'Asia/Kolkata')`; 0–30 is
`approved_at >= start(D−30)`, 31–60 is `[start(D−60), start(D−30))`, and so on, so an
order exactly 30 days old is in 0–30. Constants: `AGE_BUCKETS` (one const list; the
`AgeBucket` type derives from it) and `AGE_BUCKET_UPPER_DAYS = [30, 60, 90]`, in
`packages/contracts/src/reports.ts`; the time zone is the existing `RECEIPT_TIME_ZONE`.

**Rationale**: matches receipt dates (slice 6); ranges on `approved_at` keep the index
range (ADR-0015); the clock is injected, so tests pin boundaries.

**Alternatives**: elapsed 24-hour periods (rejected at clarify); computing the bucket per
row in a `WHERE` expression (defeats the index).

## R4. Indexes **[sign-off]**

**Decision**: migration `0017_outstanding_report` adds three partial indexes, all
`WHERE status = 'APPROVED' AND open_line_count > 0`:
- `purchase_orders_outstanding_idx (approved_at, id)` — the Admin's and Approver's
  unfiltered and bucket-only report pages and counts
- `purchase_orders_outstanding_vendor_idx (vendor_id, approved_at, id)` — vendor filter,
  and the all-scope vendor summary (index-only)
- `purchase_orders_outstanding_owner_idx (owner_id, approved_at, id) INCLUDE (vendor_id)`
  — a Buyer's report and their vendor summary (index-only)

**Rationale**: ADR-0015 names only the vendor and owner indexes. Without the first, the
unfiltered report (oldest approval first across all vendors) would sort every
outstanding order (about 44,000 at the 100k fixture) to return 20; with it the page stops
at its rows like every other list. `INCLUDE (vendor_id)` lets a Buyer's summary group
without visiting the heap. All three hold only open approved orders, so they shrink as
orders complete. ADR-0015 update.

**Alternatives**: two indexes and accept the sort (fails the plan rule "no Sort over more
than the page"); a non-partial `(status, approved_at)` index (holds every approved order
forever).

## R5. Query shapes

**Decision**:
- **Report**: one statement, page and total from one snapshot, as the order lists do
  (`SELECT (count) AS total, (json_agg page) AS items`). The page reads the chosen
  partial index (by scope and vendor filter) with the bucket range, `ORDER BY
  approved_at, id` (the index order, so the page stops at its rows). Page rows
  join `vendors` and `users` (owner name) by primary key, and a `LATERAL` aggregate over
  each page order's lines (by the order-lines key) gives its line count and outstanding
  quantity, so lines are read only for the page. Receipts are never read.
- **Count**: the same predicate, reading only the partial index (index-only).
- **Vendor summary**: `GROUP BY vendor_id` over the scope's partial index (index-only),
  `count(*)`, `count(*) FILTER (WHERE approved_at >= …)` per bucket, `min(approved_at)`;
  then the groups are sorted by oldest approval and paged, and joined to `vendors` for the
  page. Its total is the number of groups.

**Rationale**: ADR-0015's shape; one snapshot per page (as slice 3 decided for lists).

**Plan rule exception [sign-off]**: the summary must aggregate every outstanding order in
scope before it can order vendors by their oldest approval, so its plan sorts the groups
(at most the number of vendors with anything outstanding, ≤ 2,000), not the orders. The
plan test allows a Sort over groups only, bounded by the vendor count, and still forbids
any heap or Seq Scan of `purchase_orders` and any read of lines or receipts. ADR-0015 and
ADR-0012 updates.

## R6. Line detail: summary numbers in the page, lines on expand (owner, 2026-11-26)

**Decision**: report rows carry summary numbers only: `openLineCount` (stored) and
`outstandingQuantity` (summed over the page row's lines). There are no lines in the page.
Expanding a row in the UI fetches the existing `GET /orders/{id}`, which already returns
each line's ordered, received and outstanding quantities and is authorized by the same
visibility rules (anyone who sees an order in the report can read it).

**Rationale**: owner decision; keeps every page small whatever its orders' line counts
(the fixture's widest orders have 500 lines), adds no second line-detail shape to the
contract, and reuses a read that is already planned, timed and tested. ADR-0015 is
amended (it recorded inline line detail).

**Alternatives**: open lines inline (ADR-0015 as first written): up to 50 × 500 lines per
page, rejected by the owner.

## R7. Load test (clarified 2026-11-26) **[sign-off: ADR-0012 text]**

**Decision**:
- `scripts/load/run.sh`: starts an isolated stack exactly as `scripts/e2e-local.sh` does,
  but as compose project `po-load` with its own ports, a throwaway env file and the TLS
  edge; removes it with its volumes at the end. `npm run load`.
- `scripts/load/load.mjs` (plain Node, `fetch`, no new tool), fixed seed:
  1. accounts: an Admin from the operator CLI; 20 Buyers and 2 Approvers by signup,
     Mailpit verification and the Admin's role assignment; the per-address rate-limit
     buckets cleared between batches the way `frontend/e2e/support/limits.ts` does
  2. 200 vendors created by the Buyers
  3. 10,000 orders by 20 virtual users (one per Buyer), each 1–5 lines (1 in 100 with
     50–100); about 85% priced at or below the tier (auto-approved), 15% above (the
     Approvers approve most, reject about 1 in 5)
  4. receipt histories by seeded draw over approved orders: about 30% none, 35% partly
     (1–3 receipts), 35% fully; about 3% cancelled by an Approver (half after a partial
     receipt)
- Ages: orders raised in one run are all approved today. After the run the script shifts
  each order's own timestamps back by a seeded 0–180 days in one privileged statement on
  the isolated stack (as the superuser, with `session_replication_role = replica` for
  that transaction only): the order's created, submitted, approved, cancelled times, its
  rounds' and steps' times, and its receipts' dates and record times, all by the same
  offset, so every ordering the rules check still holds. Audit entries keep their real
  times (an accepted fixture artifact, stated in the run record). Guards (owner,
  2026-11-26), in `scripts/load/backdate.mjs`:
  - it refuses to run unless `COMPOSE_PROJECT_NAME` is `po-load` **and** the one running
    `db` container carries the compose label `com.docker.compose.project=po-load` (the
    check `frontend/e2e/support/limits.ts` makes for `po-e2e`); anything else exits
    non-zero before connecting
  - the superuser password is read at run time from the throwaway env file the stack was
    started with (`COMPOSE_ENV_FILES`, written by `scripts/ci-env.sh`); it is never
    committed, logged or passed on a command line (it goes to `psql` as `PGPASSWORD` in
    the exec environment)
  - reconciliation runs right after the shift, and any row fails the run
- Measurement: the run's duration; error counts by HTTP status over the whole run; then
  50 timed requests after 3 warm-up each for: report page 1 (Admin), report with a vendor
  filter, report `OVER_90`, a Buyer's report, the vendor summary (Admin); p95 against
  ADR-0012 (report 200 ms, summary 300 ms).
- The plan for outstanding orders by age: `EXPLAIN (ANALYZE, BUFFERS)` of the report page
  and count with `ageBucket=OVER_90` on the load data, rendered by
  `backend/scripts/outstanding-sql.ts` (prints the statement with literals) and run in the
  db container; committed as `docs/query-plans/load/outstanding-by-age.txt`.
- Fails (clarified 2026-11-26) on: any 5xx or timeout, any reconciliation row, or an
  unexplained unused index (R8). Timings over target are recorded, not failed.
- Record: `docs/perf/load-run.md` (one recorded run: date, commit, duration, error
  counts, timings vs targets, dataset counts, unused-index result) and the plan file.
- Nightly: a `load` job in `nightly.yml` running `npm run load` on the runner and
  uploading `reports/load/`; never on pull requests.

**Rationale**: what the owner chose; the backdating is the only way to get a spread of
ages through the API without adding a clock override to production code.

**Alternatives**: an injectable clock offset in the API, enabled only in the load stack
(production code that exists for tests); leaving all ages at 0 (the by-age plan would
prove nothing).

**ADR-0012 update**: the "50 concurrent virtual users for 10 min, median of 3 runs" load
job is replaced by this load test (about 20 users, one recorded run, fail rules above);
the 50/3 timing tests stay the latency gate.

## R8. Unused-index check

**Decision**: after the measurement phase, the load script also exercises every read the
UI offers once (each order-list filter, the approval queue, vendor list and history,
order timeline, receipt history, Admin user and access-request lists with each filter,
the Admin log), then reads `pg_stat_user_indexes` (`idx_scan = 0`, schema `public`) on
the fresh stack. Each unused index must be in `scripts/load/expected-unused-indexes.json`
(`[{ "index": …, "reason": … }]`, one line each); any other fails the run, and an index
that is in the list but was used is reported (so the list stays honest). Expected
entries are of three kinds: maintenance-only (purge and retention jobs), foreign-key
support for deletes that never happen in this traffic, and uniqueness backing.

**Rationale**: the owner's definition (clarified 2026-11-26); exercising every read makes
"unused" mean "no request of the system needs it", not "the load didn't happen to ask".

## R9. Admin list plans (closes ADR-0021)

**Decision**:
- `backend/tests/plans/users-fixture.ts`: 10,000 users (fixed seed) across every status
  and role set (ADR-0016), names and emails with realistic prefixes, and access requests
  (about 1,500 open, 4,000 closed).
- `GET /admin/access-requests` is rewritten from Prisma `findMany` + `count` to one raw
  statement (page and total from one snapshot) in its repository, behaviour unchanged
  (its integration tests pin it), so the plan tooling can EXPLAIN it **[sign-off: a
  rewrite of shipped slice 1 code]**.
- `users.plan.test.ts` and `backend/scripts/plans-users.ts` (as the vendor and order
  ones): user list page 1 and 100 and count, unfiltered and by each filter (role, status,
  name/email prefix); access requests page 1 and count, unfiltered and by status. Plans
  committed under `docs/query-plans/admin/`; the test fails on a Seq Scan or a Sort over
  more than the page.
- Timing: first page of each list, 50 timed runs after 3 warm-up, p95 ≤ 200 ms (SC-008
  of slice 1).
- `plans.yml` gains the `plans:users` step and its drift check. ADR-0021 is marked
  Closed with the commit that closes it; the README's deviation list drops it.

## R10. Report plans at the 100k fixture

**Decision**: `orders-fixture.ts`'s queries gain the report: page 1 and 100 and count for
the Admin (unfiltered, each bucket, a vendor, vendor and bucket) and for a top Buyer
(unfiltered, a bucket); the vendor summary page 1 and its total for the Admin and the
Buyer. The plan test additionally asserts the outstanding index names, no read of
`goods_receipts` or `goods_receipt_lines`, and `order_lines` read only through its key
for page rows. The fixture approves each order two hours after it was raised, so ages
follow its creation dates; the plan test sets the as-of date from the latest approval
and asserts every bucket is non-empty (if not, the fixture's dates are spread first).

## R11. Walkthrough and its check

**Decision**: `docs/walkthrough.md` rewritten in place for a new reader: purpose and
users; an order's life (draft → submit → approve/reject/withdraw → receive → cancel);
where each guarantee lives (database rule, service check, API error, screen); the three
§7 answers and the likely follow-ups, each naming files, tests (by file) and committed
plans. `scripts/check-walkthrough.mjs` extracts every backticked repository path and
fails if one doesn't exist; it runs in the gate and in CI's `static` job, with its own
test in `scripts/tests/`.

## R12. Sign-off list (owner, 2026-11-26: 1, 2, 4, 5, 6 signed off; 3 changed)

1. **R4**: a third partial index `(approved_at, id)`, and `INCLUDE (vendor_id)` on the
   owner index (ADR-0015 update).
2. **R5**: the vendor summary's plan sorts vendor groups (≤ vendor count), an exception to
   "no Sort over more than the page" (ADR-0015, ADR-0012 updates).
3. **R6**: changed by the owner: summary numbers in the page, lines via
   `GET /orders/{id}` on expand (ADR-0015 amended).
4. **R7**: signed off 2026-11-26, with guards: backdating only on the `po-load` stack
   (project name and container label checked), the superuser password only from the
   throwaway env file, reconciliation right after the shift; audit times left real;
   ADR-0012's load-job text replaced; a nightly `load` job.
5. **R9**: rewriting the access-request list as one raw statement.
6. **R11**: the walkthrough path check added to the gate and CI `static`.

No new error code, field code, role, permission or matrix cell.
