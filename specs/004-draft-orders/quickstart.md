# Quickstart: Slice 3 — Draft orders

## Prerequisites

- Node 24, Docker. `cp .env.example .env` with `SEED_DEMO_DATA=true` (local profile).

## Automated

```bash
set -o pipefail
npm test 2>&1 | tail -40              # includes the integrity suite and reconciliation
npm run test:plans 2>&1 | tail -20    # order list and timeline plans (R7)
npm run plans:orders && git status --porcelain docs/query-plans/orders   # no drift
npm run e2e:local 2>&1 | tail -20     # every e2e test but the editor benchmark
npm run perf:editor 2>&1 | tail -5    # on demand: the editor benchmark alone (SC-008)
```

Expected: all green; the reconciliation query returns zero rows after the suites and the
seed; `docs/query-plans/orders/` unchanged.

The editor benchmark (`frontend/e2e/order-editor-perf.spec.ts`, tagged `@perf`) times the
browser at 4× CPU throttling, so on a laptop in a power-saving profile it misses its
targets for the machine's reasons (quickstart-results). `npm run e2e:local` leaves it out;
CI's `e2e` job runs it on every pull request, and `npm run perf:editor` runs it alone on
its own throwaway stack, best on a balanced or performance profile.

## Manual scenarios (map to spec user stories)

1. **US1**: as a demo Buyer, create an order with lines `0.1 × 1` three times → `DRAFT`,
   PO number `PO-<FY>-…`, total `₹0.30`. Retry the same request (same `Idempotency-Key`)
   → the same order.
2. **US2**: `docker compose exec db psql -U po_app …` → `UPDATE purchase_orders SET total
   = 1` → permission denied; as `po_owner` → `PO005`.
3. **US3**: edit the draft in two tabs; save in the first, then the second → "This order
   changed since you opened it." → Reload.
4. **US4**: delete a draft through the dialog → gone from the list; as Admin, open
   `/api/orders/<id>/timeline` → `PO_DRAFT_DELETED`. Create another order: the number
   is the next one, never the deleted one.
5. **US5**: filter the list by vendor, status, PO prefix and a date range; the URL keeps
   the filters on reload.
6. **US6**: as a second Buyer, open the first Buyer's order URL → not found; as the
   Approver, `/orders` is empty; as Admin, every draft is listed read-only.
7. **Body limit**: `npm test -- order-body-limit` sends the largest valid order raw and
   escaped (201) and 4 MiB + 1 byte (413), through the API and through nginx.

Record results in `quickstart-results.md`.
