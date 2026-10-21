# ADR-0012: Performance targets, datasets and load-test execution

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (one Approver in the dataset)
- **Brief:** §3.7, §6, §8 · Gaps G5, G13, G14, Q6, Q7
- **Principles:** VII

## Decision
- Datasets come from a fixed-seed generator.
  - **Brief §8 scenario** (binding): 10k orders across 200 vendors, with its own plan.
  - **Production**: 100k orders, about 1M lines (1% of orders with 200–500 lines), about
    1.5M receipts, 2,000 vendors (top 20 ≈ 30%), 300 buyers (top 10 ≈ 25%), and **one
    Approver**, matching the business (ADR-0002). This is also the worst case for the
    approver queue: every pending order is in one queue. Approval policy: the single-tier
    seed.
  - **Users** (for the admin user list plan only): 10,000 generated users across every
    status and role set (ADR-0016).
- p95 targets: outstanding report 200 ms; vendor summary 300 ms; "my orders" for the
  **busiest** buyer 150 ms; approver queue 150 ms; create, replace or submit a 500-line
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
