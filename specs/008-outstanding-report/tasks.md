---

description: "Task list for Slice 7 — Outstanding orders report, load tests and query plans"
---

# Tasks: Slice 7 — Outstanding orders report, load tests and query plans

**Input**: Design documents from `specs/008-outstanding-report/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Required (Principle VIII). Every test task is **run and seen failing** (against
real PostgreSQL for anything touching the database) before the task that makes it pass;
its commit body carries a "Failing run:" line under 100 characters. A test that passes
first time is noted in the commit body; mutation checks only for permission checks
(owner, 2026-11-26). Requirement IDs go in test names only (ADR-0013). Never weaken, skip
or delete a test to pass.

**Commits**: every commit through `npm run gate` (scripts/gate.sh); no repeat runs of a
passing suite; a test that passes on rerun is noted, not investigated (owner,
2026-11-26).

**Operations per story**: Foundational adds constants and schemas but no operation. US1
adds `listOutstandingOrders`, US2 `listOutstandingVendors`, each with its route, and grows
the OpenAPI operation list, the route table and the authorization-matrix pins in the same
commit.

**Organization**: Setup, Foundational, then US1 → US2 → US3 → report plans → US5 → US4 →
US6 (plan order), then Polish. Each story ends with green CI on the slice's draft PR.

## Format: `- [ ] T### [P?] [US#?] Outcome — files — refs`

- **[P]**: parallel with the other [P] tasks of the same group (different files, no
  dependency on an incomplete task).
- **Refs**: spec FR/SC, research R#, ADR, and the `docs/traceability.md` row ID the tests
  carry.
- **Layering**: `routes.ts` → `service.ts` → `repository.ts`; routes never import Prisma,
  a repository or `db/transaction.ts`.
- No `.env*` change in this slice; if one turns out to be needed, stop and ask the owner.

---

## Phase 1: Setup

- [X] T001 Commit the spec, plan, research, data model, contracts, quickstart, tasks and
  the ADR updates (0012, 0013, 0015, 0021 closure plan; owner sign-off 2026-11-26); draft
  PR for `008-outstanding-report` against `main` (additive contract: no `breaking`
  label) — GitHub.

---

## Phase 2: Foundational

- [X] T002 [P] Migration `0017_outstanding_report`: the three partial indexes
  `purchase_orders_outstanding_idx (approved_at, id)`,
  `purchase_orders_outstanding_vendor_idx (vendor_id, approved_at, id)`,
  `purchase_orders_outstanding_owner_idx (owner_id, approved_at, id) INCLUDE (vendor_id)`,
  each `WHERE status = 'APPROVED' AND open_line_count > 0`; test first: the indexes exist
  with exactly that predicate, and the `'APPROVED'` literal is pinned to `ORDER_STATUS` —
  `backend/prisma/migrations/0017_outstanding_report/migration.sql`,
  `backend/prisma/schema.prisma`, `backend/tests/integration/order-constants.test.ts` —
  FR-011, R4, ADR-0015, FR-RPT-02.
- [X] T003 [P] Contracts: `AGE_BUCKETS`, `AgeBucket`, `AGE_BUCKET_UPPER_DAYS` in
  `packages/contracts/src/reports.ts`; `outstandingReportQuery`, `outstandingVendorsQuery`,
  `outstandingOrder` (with `outstandingQuantity` ≥ 1, no lines), `outstandingVendor`
  (`byBucket` keys built from `AGE_BUCKETS`), both pages with `asOf`, in
  `schemas/reports.ts`, exported from `index.ts`; schema tests first (strict queries,
  unknown field, bad bucket, bad uuid, `byBucket` has exactly the four keys) —
  `packages/contracts/tests/report-schemas.test.ts` — FR-002, FR-002a, FR-003, FR-009,
  R1, R3, FR-RPT-01.
- [X] T004 [P] Web words: bucket labels as `Record<AgeBucket, string>`, age text ("today",
  "1 day", "{n} days"), the as-of line, empty states; unit test first —
  `frontend/src/pages/reports/report-words.ts`, `frontend/tests/report-words.test.ts` —
  ui.md, FR-RPT-01.

---

## Phase 3: User Story 1 — Outstanding orders by vendor and age (P1)

**Goal**: the report lists exactly the outstanding orders, filterable by vendor and age
band, paged, ages as of a shown India date. **Independent test**: spec US1.

- [X] T005 [US1] Integration tests, seen failing: only approved orders with an open line
  (cancelled, rejected, pending, draft, fully received excluded); a partial receipt keeps
  an order (open-line count and outstanding quantity drop), the final receipt removes it;
  each bucket with an injected clock, orders exactly 30, 60 and 90 days old in the lower
  bucket, the 23:50 India-time case; `asOf` the clock's India date; vendor filter, bucket
  filter, both; stable oldest-first paging with the true total; empty and past-the-last
  pages; a vendor with nothing outstanding → empty; invalid filters → 400 naming the
  field; inactive vendor marked; `lineCount` and `outstandingQuantity` exact —
  `backend/tests/integration/reports-outstanding.test.ts` — FR-001–FR-004, FR-007–FR-009,
  R3, R5, FR-RPT-01, FR-RPT-03.
- [X] T006 [US1] `listOutstandingOrders`: operation, route, service (clock-injected as-of
  date, scope by role) and repository (one statement, page and total, the scope's partial
  index, bucket bounds as India midnights, page-row aggregate over lines, no receipts);
  OpenAPI regenerated; route table and matrix pins grown — `packages/contracts/src/
  operations.ts`, `backend/src/reports/{routes,service,repository}.ts`,
  `backend/src/http/routes/index.ts` — FR-001–FR-008, R1–R5, FR-RPT-01.
- [X] T007 [US1] Query count, seen failing until T006: one statement per report request,
  whatever the page size or line counts — `backend/tests/integration/reports-query-count.test.ts`
  — FR-011, NFR-PERF-01.
- [X] T008 [P] [US1] Web component tests, seen failing: Orders view heading and as-of
  line; filters in the URL (vendor, age) and the bad-link state; table columns; empty
  states; pagination; **Show lines** fetches `GET /orders/{id}` with its own loading and
  error state and shows each line's ordered, received and outstanding; nav item for
  Buyer, Approver, Admin, not for no role; axe —
  `frontend/tests/outstanding-report.test.tsx` — FR-004, FR-010, SC-008, ui.md,
  FR-RPT-01.
- [X] T009 [US1] Orders view, route (lazy, `RequireRole operation="listOutstandingOrders"`)
  and nav item — `frontend/src/pages/reports/OutstandingReport.tsx`,
  `frontend/src/app/router.tsx`, `frontend/src/app/Shell.tsx` — FR-010.

---

## Phase 4: User Story 2 — Vendor summary (P1)

**Goal**: per vendor with anything outstanding, counts per band and oldest approval.
**Independent test**: spec US2.

- [X] T010 [US2] Integration tests, seen failing: one row per vendor with outstanding
  orders (none for a vendor with only fully received orders); `orderCount`, `byBucket`
  and `oldestApprovedOn` exact; inactive vendor kept and marked; paged oldest approval
  first then vendor name; `asOf`; a receipt that completes an order updates the counts —
  `backend/tests/integration/reports-vendors.test.ts` — FR-005, FR-008, R5, FR-RPT-01.
- [X] T011 [US2] `listOutstandingVendors`: operation, route, service, repository (group
  over the scope's partial index, bucket counts, oldest, then page the groups and join
  vendors); OpenAPI regenerated; pins grown — `backend/src/reports/*`,
  `packages/contracts/src/operations.ts` — FR-005, R5.
- [X] T012 [US2] Web, tests first: By vendor view (table, links to the Orders view
  filtered to the vendor, empty state, as-of line, axe) and the two tab links —
  `frontend/src/pages/reports/OutstandingVendors.tsx`,
  `frontend/tests/outstanding-vendors.test.tsx`, `frontend/src/app/router.tsx` — FR-010,
  SC-008, ui.md.

---

## Phase 5: User Story 3 — Each caller sees only what they may read (P1)

- [X] T013 [US3] Authorization matrix rows for both reads × callers, seen failing on any
  cell not yet right: Buyer sees and counts only their own; another Buyer theirs; Approver,
  Admin and Buyer+Approver all; no role `403 NO_ROLE_ASSIGNED`; anonymous `401`;
  mutation-check the scope (make a Buyer see all; the cells fail) and record it in the
  commit body — `backend/tests/integration/authorization-matrix.test.ts`,
  `backend/tests/integration/reports-scope.test.ts` — FR-006, R2, ADR-0004, FR-OWN-01,
  FR-RPT-01.

---

## Phase 6: Report plans and timings (FR-RPT-02)

- [X] T014 Plan queries in the 100k fixture, and assertions, seen failing: report page 1
  and 100 and count for the Admin (unfiltered, each bucket, a vendor, vendor and bucket)
  and a top Buyer (unfiltered, a bucket); summary page 1 and total for the Admin and the
  Buyer; each uses its outstanding index, reads no `goods_receipts` or
  `goods_receipt_lines`, reads `order_lines` only by key for page rows; the summary may
  sort its groups only (bounded by the vendor count); the fixture's as-of date from its
  latest approval, every bucket non-empty — `backend/tests/plans/orders-fixture.ts`,
  `backend/tests/plans/orders.plan.test.ts` — FR-011, FR-012, R5, R10, ADR-0012,
  FR-RPT-02, NFR-PERF-01. **If a plan fails the rule, stop and show the owner the plan.**
- [X] T015 Commit the report and summary plans (`npm run plans:orders`) —
  `docs/query-plans/orders/report-*.txt`, `summary-*.txt` — FR-012, SC-003.
- [X] T016 Timings, 50 timed after 3 warm-up: report page 1 (Admin, and a Buyer) p95 ≤
  200 ms, summary ≤ 300 ms — `backend/tests/plans/orders.timing.test.ts` — SC-001,
  NFR-PERF-01.

---

## Phase 7: User Story 5 — Admin list plans at 10,000 users (P2; closes ADR-0021)

- [X] T017 [US5] The access-request list as one raw statement (page and total from one
  snapshot), behaviour unchanged: the existing list tests stay green; a new test pins the
  order, filters and total — `backend/src/access-requests/repository.ts`,
  `backend/tests/integration/access-requests*.test.ts` — FR-017, R9.
- [X] T018 [US5] 10,000-user fixture (every status and role set, realistic name and email
  prefixes, about 1,500 open and 4,000 closed access requests) and plan test, seen
  failing: user list page 1 and 100 and count, unfiltered and by role, status and prefix;
  access requests page 1 and count, unfiltered and by status; no Seq Scan, no Sort over
  the page, also under a generic plan — `backend/tests/plans/users-fixture.ts`,
  `backend/tests/plans/users.plan.test.ts` — FR-017, SC-006, R9.
- [X] T019 [US5] Plans writer and CI: `backend/scripts/plans-users.ts`, `plans:users`
  scripts (backend and root), the `plans.yml` step and drift check; plans committed under
  `docs/query-plans/admin/` — FR-017.
- [X] T020 [US5] Timings: first page of each list, 50 timed after 3 warm-up, p95 ≤ 200 ms
  — `backend/tests/plans/users.timing.test.ts` — SC-006.
- [X] T021 [US5] Close ADR-0021 (status Closed, the commit named), drop it from the
  README's open deviations; traceability note for the admin lists' plans —
  `docs/adr/0021-*.md`, `docs/adr/README.md`, `docs/traceability.md` — FR-017.

---

## Phase 8: User Story 4 — 10,000-order load test (P2)

- [ ] T022 [P] [US4] Seeded load plan, test first (`node --test`): 10,000 orders, 200
  vendors, 20 Buyers, 2 Approvers; line counts 1–5 with 1 in 100 at 50–100; about 85%
  at or below the tier; approve/reject and receipt/cancel draws in the R7 ranges; the same
  seed gives the same plan — `scripts/load/plan.mjs`, `scripts/tests/load-plan.test.mjs`
  — FR-013, R7, NFR-PERF-02.
- [ ] T023 [P] [US4] Unused-index comparison, test first: an unused index not in the
  expected list fails; an expected one that was used is reported; the list's entries each
  need a one-line reason — `scripts/load/indexes.mjs`,
  `scripts/tests/load-indexes.test.mjs` — FR-016, R8.
- [ ] T024 [P] [US4] Backdate guard, test first (stub `docker`): refuses unless
  `COMPOSE_PROJECT_NAME` is `po-load` and the one `db` container has that project label;
  reads the superuser password from the throwaway env file and never puts it in argv or
  output; runs reconciliation right after the shift and fails on any row —
  `scripts/load/backdate.mjs`, `scripts/tests/load-backdate.test.mjs` — R7 (owner
  guards, 2026-11-26).
- [ ] T025 [US4] Stack and driver: `scripts/load/run.sh` (compose project `po-load`, own
  ports, throwaway env from `scripts/ci-env.sh`, TLS edge, `trap` down -v and env file
  removal), `scripts/load/load.mjs` (accounts via CLI, signup, Mailpit and role
  assignment, per-address limits cleared; 200 vendors; 10,000 orders by 20 virtual users
  through the API; receipts, cancels and rejections; error counts by status; fails on any
  5xx or timeout); `npm run load` — FR-013, FR-016a, R7.
- [ ] T026 [US4] Measurement and evidence: after the backdate, 50 timed after 3 warm-up for
  the R7 requests (p95 against 200/300 ms, recorded); every UI read exercised once (R8);
  the outstanding-by-age `EXPLAIN (ANALYZE, BUFFERS)` via
  `backend/scripts/outstanding-sql.ts` in the db container; the index check; a run record
  writer (test first for the record's shape) — `scripts/load/*.mjs`,
  `backend/scripts/outstanding-sql.ts`, `scripts/tests/load-record.test.mjs` — FR-014,
  FR-015, FR-016, R7, R8.
- [ ] T027 [US4] The expected-unused list from the first run, each entry with its
  one-line reason (maintenance-only, delete-only foreign keys, uniqueness backing). **Any
  index that is neither used nor justifiable: stop and show the owner before dropping
  it** — `scripts/load/expected-unused-indexes.json` — FR-016, SC-005.
- [ ] T028 [US4] One recorded run committed: `docs/perf/load-run.md` and
  `docs/query-plans/load/outstanding-by-age.txt` — FR-014, FR-015, SC-002, SC-003,
  NFR-PERF-02, NFR-PERF-04.
- [ ] T029 [US4] Nightly `load` job (`npm run load`, upload `reports/load/`), never on
  pull requests — `.github/workflows/nightly.yml` — FR-013.

---

## Phase 9: User Story 6 — Walkthrough (P3)

- [ ] T030 [US6] Walkthrough check, test first (`node --test`): every backticked
  repository path in the document must exist; a missing one fails with its line —
  `scripts/check-walkthrough.mjs`, `scripts/tests/check-walkthrough.test.mjs`,
  `package.json` (`check:walkthrough`), `scripts/gate.sh` (and its test), `ci.yml`
  (`static`) — FR-019, R11, ADR-0013.
- [ ] T031 [US6] Rewrite `docs/walkthrough.md` for a new reader: purpose and users; an
  order's life; where each guarantee lives; the three §7 answers and likely follow-ups,
  each naming files, tests and committed plans (the load plan for §7.3) — FR-018, SC-007,
  §7.1–7.3 row.

---

## Phase 10: Polish

- [ ] T032 E2E: the Admin opens the report, filters by vendor and age, expands a row's
  lines, opens By vendor and follows a vendor to the filtered report; a Buyer sees only
  their own; axe on both views — `frontend/e2e/report.spec.ts` — FR-010, SC-004, SC-008,
  NFR-FE-07.
- [ ] T033 Demo data in the report: each demo Buyer's partly received approved order is
  outstanding, the fully received and cancelled ones are not —
  `backend/tests/integration/seed-demo.test.ts` — FR-001.
- [ ] T034 Traceability: FR-RPT-01, FR-RPT-02, FR-RPT-03 (report half), NFR-PERF-01,
  NFR-PERF-02, NFR-PERF-04, FR-OWN-01 (report rows), the §7.1–7.3 walkthrough row, the
  admin lists' plans; `npm run check:traceability` green — `docs/traceability.md`.
- [ ] T035 Quickstart run with the local driver (`.local/quickstart/`, extended for this
  slice) and results; slice-end `/code-review`, `/security-review`, constitution pass,
  open-deviation re-check (none left); fix findings; gate green —
  `specs/008-outstanding-report/quickstart-results.md`.

---

## Requirement coverage

| Requirement | Tasks |
|---|---|
| FR-001–FR-004, FR-007–FR-009 | T005, T006, T008, T033 |
| FR-002a (India calendar days, as-of) | T003, T005, T006 |
| FR-005 | T010, T011, T012 |
| FR-006 | T006, T013 |
| FR-010 | T004, T008, T009, T012, T032 |
| FR-011, FR-012 | T002, T007, T014, T015 |
| FR-013–FR-016a | T022–T029 |
| FR-017 | T017–T021 |
| FR-018, FR-019 | T030, T031 |
| SC-001 | T016 |
| SC-002, SC-003 | T015, T028 |
| SC-004, SC-008 | T008, T012, T032 |
| SC-005 | T027 |
| SC-006 | T018, T020 |
| SC-007 | T030, T031 |

## Dependencies and execution order

- Setup → Foundational (T002–T004 in parallel) → US1 → US2 → US3 → report plans → US5 →
  US4 → US6 → Polish.
- US1: T005 → T006 → T007; T008 → T009 (T008 can start after T003, T004).
- US2 after US1 (same area); US3 after US2 (both reads exist).
- Report plans after US2 (both queries exist); T014 → T015 → T016.
- US5 is independent of the report and may run beside it; T017 → T018 → T019 → T020 →
  T021.
- US4 after report plans (it measures the report): T022–T024 in parallel → T025 → T026 →
  T027 → T028 → T029.
- US6 last of the stories (it cites the plans and the load record): T030 → T031.

## Parallel examples

- Foundational: T002, T003, T004 together.
- US4: T022, T023, T024 together (pure scripts, stubbed).

## Implementation strategy

MVP is US1 (the report itself, brief §3.7). Then US2 and US3 complete the report; the
plan phase proves its cost; US5 closes ADR-0021; US4 and US6 deliver the brief's §8 load
test and §7 walkthrough. Each story is committed through the gate and pushed; CI green on
the draft PR before the next.
