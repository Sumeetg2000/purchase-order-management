# ADR-0012: Performance targets, datasets and load-test execution

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (one Approver in the dataset) ·
  amended 2026-11-03 (POC scope, owner decision: the user dataset is built in slice 7,
  ADR-0021) · amended 2026-11-06 (audit-entry volume recorded, slice 2 analysis) ·
  amended 2026-11-17 (order status mix and the approver-queue plans, slice 4 plan) · amended 2026-11-20 (1,000 cancelled orders in the status mix, slice 5 plan)
- **Brief:** §3.7, §6, §8 · Gaps G5, G13, G14, Q6, Q7
- **Principles:** VII

## Decision
- Datasets come from a fixed-seed generator.
  - **Brief §8 scenario** (binding): 10k orders across 200 vendors, with its own plan.
  - **Production**: 100k orders, about 1M lines (1% of orders with 200–500 lines), about
    1.5M receipts, 2,000 vendors (top 20 ≈ 30%), 300 buyers (top 10 ≈ 25%), and **one
    Approver**, matching the business (ADR-0002). This is also the worst case for the
    approval queue: every pending order is in one queue. Approval policy: the single-tier
    seed.
  - **Order status mix** (amended 2026-11-17, slice 4): 5,000 `DRAFT`, 3,000
    `PENDING_APPROVAL`, 2,000 `REJECTED`, 90,000 `APPROVED` (later slices split the
    approved orders into cancelled and receipt states). *Amended 2026-11-20 (slice 5,
    owner sign-off)*: 1,000 of the 90,000 are `CANCELLED` (so 89,000 `APPROVED`), each
    with its cancel record and its round closed approved, with matching approval rounds and
    steps. For the queue's own-order exclusion, the plan fixture also gives one of the top
    10 Buyers `{BUYER, APPROVER}`.
  - **Order lists at this mix** (amended 2026-11-18, owner decision): the non-draft
    scopes walk partial indexes on `status <> 'DRAFT'`, and status with vendor has its own
    indexes (slice 4 research R7). Every list and count plan stops at its page; no
    combined-filter exception is needed.
  - **Audit entries**: about **2M**, matching the production dataset above (about 100k
    orders × their lifecycle events, plus about 1.5M receipt events and the vendor and user
    events); for vendor history, about 10,000 vendor entries across the 2,000 vendors.
    Every plan that reads `audit_entries` (vendor history, order timelines, the Admin log)
    runs at this size.
  - **Users** (for the admin user list plan only): 10,000 generated users across every
    status and role set (ADR-0016), built in slice 7 (ADR-0021).
- p95 targets: outstanding report 200 ms; vendor summary 300 ms; "my orders" for the
  **busiest** buyer 150 ms; approval queue 150 ms; create, replace or submit a 500-line
  order 500 ms each; a single receipt or approval 150 ms; 50 concurrent virtual users for
  10 min with zero pool-exhaustion or timeout errors, < 0.1% errors, and zero reconciliation
  rows.
- Page 100 (offset about 5,000) is measured and recorded with no target.
- **Frontend targets** (Playwright, 4× CPU throttling, production build):
  - 500-line editor: keystroke in a cell → next paint p95 ≤ 50 ms; add or remove a line
    p95 ≤ 100 ms; a loaded 500-line order interactive within 1,000 ms.
  - Interaction to Next Paint ≤ 200 ms on core flows.
  - Bundle budget (gzip): initial shell + login ≤ 200 KB JS; each route chunk ≤ 150 KB.
    CI fails when exceeded.
- `EXPLAIN (ANALYZE, BUFFERS)` for every list and report, including the `COUNT`.
- Load job on `main` and nightly, failing when the median p95 across 3 runs exceeds a
  target. Results go to artifacts. `docs/perf/` is refreshed in PRs of slices that affect
  performance. Deterministic trigger-count tests run on every PR.
