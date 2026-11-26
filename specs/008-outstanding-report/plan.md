# Implementation Plan: Slice 7 — Outstanding orders report, load tests and query plans

**Branch**: `008-outstanding-report` | **Date**: 2026-11-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-outstanding-report/spec.md`

## Summary

The last slice:
- the outstanding-orders report and vendor summary (brief §3.7), read from the stored
  open-line count and received quantities, scoped by ADR-0004, ages in India calendar
  days as of a shown date; three partial indexes **[sign-off]**; one-statement pages that
  never read receipts and read lines only for the page
- a 10,000-order, 200-vendor load test through the HTTP API (a plain Node script, about
  20 virtual users), on demand and nightly, with one recorded run, the
  outstanding-by-age plan on its data, and an unused-index check against a committed
  list **[sign-off: ages shifted after the run]**
- committed plans for the Admin user and access-request lists at 10,000 users, closing
  ADR-0021
- the walkthrough rewritten for a new reader, with a check that every path it names
  exists

Decisions in [research.md](research.md) (R1–R12, sign-offs in R12); indexes and derived
views in [data-model.md](data-model.md); schemas, operations and OpenAPI diff in
[contracts/api.md](contracts/api.md), screens in [contracts/ui.md](contracts/ui.md).

## Technical Context

**Language/Version**: TypeScript 6 (`strict`) on Node.js 24; SQL for PostgreSQL 17

**Primary Dependencies**: the slice 0–6 stack; no new dependency (the load test is plain
Node `fetch`).

**Storage**: PostgreSQL 17. Migration `0017_outstanding_report`: three partial indexes
on `purchase_orders`. No table, column, trigger, grant or reconciliation change.

**Testing**: Vitest + Supertest + Testcontainers PostgreSQL 17: report and summary
service and routes (contents, receipts moving orders in and out, filters, bucket
boundaries with an injected clock, pagination, scope per role); authorization matrix
rows for the two reads; plan tests at the 100k order fixture (report, summary) and the
10k user fixture (Admin lists); timing tests (report 200 ms, summary 300 ms, Admin lists'
first pages 200 ms; 50 timed after 3 warm-up); script tests (`node --test`) for the load
test's pure parts (seeded plan, unused-index comparison, run record) and the walkthrough
check; Testing Library + vitest-axe + MSW; Playwright + axe for the report.

**Target Platform**: the existing compose stack; the load test uses its own isolated
compose project (`po-load`).

**Project Type**: web application (API + SPA), npm workspaces.

**Performance Goals**: ADR-0012: report p95 ≤ 200 ms, vendor summary ≤ 300 ms (100k
fixture, and recorded on the load dataset); Admin user list and access-request list first
page ≤ 200 ms at 10,000 users; page 100 measured, no target.

**Constraints**: no stored value added; receipts never read by the report; contract
additive; the load test never on pull-request CI; no `.env` change.

**Scale/Scope**: 2 new operations, 1 rewritten repository read; 3 indexes; 1 page with 2
views; 1 load script with its stack script; 1 users fixture and plan set; 1 doc rewrite
and its check; ADR updates (0012, 0015, 0021).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this slice complies | Status |
|---|---|---|
| I. Derived-value integrity | Reads INV-3/INV-6 values only; no new derived value; reconciliation after the load run and its age shift | Pass |
| II. State machine | No transition; the load test reaches every state through the API's own rules | Pass |
| III. Authorization | ADR-0004's existing report row; route roles Buyer/Approver/Admin; Buyer-only callers scoped to their own orders in SQL; matrix tests for both reads × every caller | Pass |
| IV. Audit | Reads write nothing; the load run's audit entries are real (their times are not shifted, stated in the run record) | Pass |
| V. Concurrency | One snapshot per page (page and total in one statement); load test exercises 20 concurrent users and fails on any 5xx or timeout | Pass |
| VI. API contract | Zod first; two additive operations; strict queries; no new code | Pass |
| VII. Performance | Partial indexes; page stops at its rows; count index-only; plans committed at 100k orders, 10k users and the 10k load dataset; the summary's group sort recorded as an exception **[sign-off]** | Pass |
| VIII. Test-first | Each story's tests first, seen failing against Testcontainers | Pass |
| IX. Operability and security | Load stack isolated with a throwaway env; no secret committed; no config change | Pass |
| X. Brief binding | §3.7, §7, §8 load test; ADR updates listed for review; no matrix change | Pass |
| XI. Code clarity | `reports/` area (routes → service → repository); constants once (buckets, time zone); IDs only in test names | Pass |
| XII. Simplicity | No new table, column or dependency; reuses pagination, scope, plan tooling | Pass |
| XIII. Frontend | Generated client; states; URL filters; disclosure rows; axe | Pass |

**Gate result (pre-research)**: PASS.

**Re-check after Phase 1 design**: PASS. One open deviation is closed by this slice
(ADR-0021); none added. ADR updates written after the owner signs off research R12:
ADR-0015 (third index, `INCLUDE`, India calendar days and as-of date, the summary's
group sort), ADR-0012 (the load test as clarified; recorded run; the summary exception),
ADR-0021 (Closed), ADR-0013 (the walkthrough check).

## Project Structure

### Documentation (this feature)

```text
specs/008-outstanding-report/
├── spec.md, checklists/requirements.md
├── plan.md            # this file
├── research.md        # R1–R12
├── data-model.md
├── quickstart.md
├── contracts/         # api.md, ui.md
└── tasks.md           # /speckit-tasks
```

### Source Code (new and changed)

```text
packages/contracts/src/
├── reports.ts                    # AGE_BUCKETS, AGE_BUCKET_UPPER_DAYS
├── schemas/reports.ts            # queries, items, pages
└── operations.ts                 # + listOutstandingOrders, listOutstandingVendors
backend/prisma/migrations/0017_outstanding_report/migration.sql
backend/src/
├── reports/routes.ts, service.ts, repository.ts       # new area
├── access-requests/repository.ts                      # list as one raw statement
└── http/routes/index.ts                               # register reports routes
backend/scripts/
├── plans-users.ts                # Admin list plans writer
└── outstanding-sql.ts            # renders the report SQL for the load stack's EXPLAIN
backend/tests/
├── integration/reports-*.test.ts, authorization-matrix.test.ts, access-requests*.test.ts
├── plans/orders-fixture.ts (+ report queries), orders.plan.test.ts, orders.timing.test.ts,
│   users-fixture.ts, users.plan.test.ts
scripts/
├── load/run.sh, load.mjs, plan.mjs, backdate.mjs, expected-unused-indexes.json
├── check-walkthrough.mjs
└── tests/load-*.test.mjs, check-walkthrough.test.mjs
docs/
├── query-plans/orders/report-*.txt, summary-*.txt; admin/*.txt; load/outstanding-by-age.txt
├── perf/load-run.md
├── walkthrough.md
└── adr/0012, 0015, 0021, 0013, README.md
frontend/src/
├── pages/reports/OutstandingReport.tsx, OutstandingVendors.tsx, report-words.ts
├── app/router.tsx, app/Shell.tsx
frontend/tests/outstanding-report.test.tsx, outstanding-vendors.test.tsx
frontend/e2e/report.spec.ts
.github/workflows/nightly.yml (+ load), plans.yml (+ plans:users), ci.yml (static: walkthrough check)
package.json                       # load, plans:users, check:walkthrough; gate step
```

**Structure Decision**: a `reports/` area, since the report is a read with its own
scope, query and response and is called by no command; `orders/` is unchanged. Load
tooling lives under `scripts/load/` beside the e2e stack scripts it mirrors.

## Story order for `/speckit-tasks`

1. **Foundational**: migration 0017; contracts (constants, schemas, operations); route
   registration; web words.
2. **US1 Report** (P1): service and repository (scope, filters, buckets with an injected
   clock, summary numbers per row, one statement), route; receipts moving orders in and out; page
   (Orders view).
3. **US2 Vendor summary** (P1): query, route; By vendor view.
4. **US3 Scope** (P1): matrix rows for both reads × every caller; Buyer-only scoping.
5. **Report plans** (FR-RPT-02): fixture queries, plan test assertions (indexes, no
   receipts, lines only for the page, summary's group sort), timings; re-commit plans.
   If a plan fails, stop and show the owner.
6. **US5 Admin list plans**: access-request list as one statement (tests first), users
   fixture, plan test and writer, timings, `plans.yml`; close ADR-0021.
7. **US4 Load test** (P2): stack script, seeded plan and comparison tests, load script,
   age shift, measurement, plan capture, unused-index check and list; one recorded run;
   nightly job.
8. **US6 Walkthrough** (P3): check script and test, then the rewrite.
9. **Polish**: e2e (report and summary, filters, axe), demo-data check, traceability
   (FR-RPT-01, FR-RPT-02, NFR-PERF-01, NFR-PERF-02, NFR-PERF-04, §7 walkthrough row,
   SC-008 of slice 1), quickstart run (local driver), reviews.

Each story: tests first, seen failing against real PostgreSQL, then code.

## Complexity Tracking

No constitution violation to justify. The vendor summary's sort of vendor groups is an
exception to a plan-test rule (ADR-0012), not to a principle, and is listed for sign-off.
