# Data model: Slice 7 — Outstanding orders report

No new table and no new stored value. The report reads what slices 3–6 store and
reconcile: `purchase_orders.open_line_count` (INV-6) and `order_lines.received_quantity`
(INV-3, INV-4). Decisions in [research.md](research.md).

## Migration `0017_outstanding_report`

Three partial indexes on `purchase_orders`, all with the predicate
`WHERE status = 'APPROVED' AND open_line_count > 0` (research R4):

| Index | Columns | Serves |
|---|---|---|
| `purchase_orders_outstanding_idx` | `(approved_at, id)` | report page and count for Approver/Admin, unfiltered or by bucket |
| `purchase_orders_outstanding_vendor_idx` | `(vendor_id, approved_at, id)` | report by vendor (± bucket); vendor summary for Approver/Admin (index-only) |
| `purchase_orders_outstanding_owner_idx` | `(owner_id, approved_at, id) INCLUDE (vendor_id)` | a Buyer's report (± bucket, ± vendor) and summary (index-only) |

Created `CONCURRENTLY` is not needed (migrations run before the API starts). The
predicate's literal `'APPROVED'` is pinned to `ORDER_STATUS` by a test, as earlier
partial indexes are. No grant changes: `po_app` already reads `purchase_orders`,
`order_lines`, `vendors` and `users`.

## Derived view: outstanding order (not stored)

| Field | Source |
|---|---|
| id, PO number, created at, approved at | `purchase_orders` |
| approved on | `(approved_at AT TIME ZONE 'Asia/Kolkata')::date` |
| age (days) | as-of India date − approved on |
| age bucket | `DAYS_0_30` (≤ 30), `DAYS_31_60`, `DAYS_61_90`, `OVER_90` (> 90) |
| vendor (id, name, status) | `vendors`, current values |
| owner (id, name) | `users`, current name |
| open line count | `open_line_count` (stored, reconciled) |
| line count | the order's lines, counted for page rows only (as the order lists do) |
| outstanding quantity | Σ (`quantity` − `received_quantity`) over the order's lines, for page rows only |

**Outstanding** ⇔ `status = 'APPROVED' AND open_line_count > 0` (ADR-0015).
Bucket bounds are India midnights of the as-of date minus 30, 60 and 90 days (R3).

## Derived view: vendor summary row (not stored)

`vendor` (id, name, status), `orderCount`, `byBucket` {four counts}, `oldestApprovedOn`,
over the caller's scope, one row per vendor with at least one outstanding order.

## Constants (`packages/contracts/src/reports.ts`)

- `AGE_BUCKETS = ['DAYS_0_30', 'DAYS_31_60', 'DAYS_61_90', 'OVER_90'] as const`;
  `AgeBucket` derives from it.
- `AGE_BUCKET_UPPER_DAYS = [30, 60, 90] as const` (the inclusive upper bounds).
- The time zone is `RECEIPT_TIME_ZONE` (one India time zone for every date the business
  reads).

## Fixtures

- **100k plan fixture** (`backend/tests/plans/orders-fixture.ts`): unchanged data; its
  receipt mix already leaves about 19,000 untouched and 25,000 partly received approved
  orders outstanding, with approvals spread over months. New plan queries only (R10).
- **10,000-user fixture** (`backend/tests/plans/users-fixture.ts`, new): users across
  every status and role set, and access requests (open and closed), fixed seed (R9).
- **Load-test dataset** (built through the API, R7): 10,000 orders, 200 vendors, 20
  Buyers, 2 Approvers; ages spread 0–180 days by one privileged shift on the isolated
  stack after the run.

## Reconciliation

Unchanged: INV-3 and INV-6 already cover everything the report reads. It runs after the
load test's shift and at the end of the run.
