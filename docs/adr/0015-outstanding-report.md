# ADR-0015: Outstanding orders report

- **Status:** Accepted · 2026-10-16
- **Brief:** §3.7, §6, §7.3, §8
- **Principles:** I, VII

## Context
§3.7 asks for outstanding orders (not yet fully received) grouped or filterable by vendor,
with an age, as a real query whose cost can be explained as orders accumulate. The
walkthrough claims the report is served by a partial index without touching lines or
receipts. That is only true if "outstanding" can be decided from the order row alone.

## Decision
- `purchase_orders.open_line_count` holds the number of lines where
  `received_quantity < quantity` (**INV-6**).
  - It is maintained by the same statement-level triggers that maintain received quantity
    (on receipt insert) and by line insert, update and delete while the order is a draft.
  - It is covered by the overwrite guard (`DERIVED_VALUE_READ_ONLY`), and the application
    role can't write it.
  - It is included in the reconciliation query.
- **Outstanding** = `status = 'APPROVED' AND open_line_count > 0`. Cancelled, rejected and
  fully received orders drop out automatically.
- **Age** is measured from `approved_at`, when the obligation to the vendor began.
  `created_at` is also returned. Buckets: 0–30, 31–60, 61–90 and over 90 days. Buckets are
  computed from `approved_at` ranges, so the index range is used.
- **Indexes**:
  - `(vendor_id, approved_at) WHERE status = 'APPROVED' AND open_line_count > 0`, for the
    vendor filter and summary
  - `(owner_id, approved_at)` with the same predicate, for a Buyer's own report (Principle
    III scoping)
- **Query shape**:
  - The page query and its `COUNT` read only the partial index and the order rows, joined
    to vendors for names.
  - Line detail (outstanding per line) is fetched in one query for the ≤ 50 orders on the
    page.
  - The per-vendor summary (order count, count per bucket, oldest `approved_at`) is an
    index-range aggregate.
  - Neither query reads receipts.
- No outstanding *amount* is reported. It would need another stored derived value, and the
  brief doesn't ask for it.

## Alternatives
- `EXISTS (lines with outstanding > 0)` per order: correct, but it touches lines for every
  candidate order, so cost grows with line count.
- A materialized view refreshed periodically: stale, which contradicts "trustworthy view".

## Consequences
- The index stays small: it holds only approved orders still open, and shrinks as orders
  complete.
- §7.3 answer: "It touches the partial index on approved, still-open orders and those order
  rows, plus vendors for names, and lines only for the page being returned. Never receipts."

## Tests
Filters by vendor and age bucket; excludes cancelled, rejected and fully received orders; a
partial receipt keeps the order in the report, and the final receipt removes it;
`open_line_count` in reconciliation; a raw-SQL write to `open_line_count` →
denied/`DERIVED_VALUE_READ_ONLY`; committed `EXPLAIN` (10k and 100k datasets) showing the
partial index for page and `COUNT`, with no lines/receipts scan.
