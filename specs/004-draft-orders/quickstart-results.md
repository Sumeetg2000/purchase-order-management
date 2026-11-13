# Quickstart results: Slice 3 — Draft orders

Run 2026-11-13 against a clean stack: a throwaway env file from `.env.example` with random
secrets (`scripts/ci-env.sh`, `SEED_DEMO_DATA=true`), `docker compose up -d --build --wait`
as an isolated compose project (`po-qs`, image tag `qs`, ports 28080 and 28025, removed
with its volumes afterwards and the env file deleted), so the default stack was never
touched. Steps 1–6 were driven over HTTP through `web` (`/api`) as the demo Buyers and the
demo Approver, plus an Admin made with the operator CLI (`admin:create`, set-password
→ 204); step 2 through `docker compose exec db psql`. The browser-only parts are covered
by `frontend/e2e/orders.spec.ts` (5 passed the same day).

**Result: 37 checks, 0 failed.** `api`, `db`, `mailpit` and `web` healthy; `maintenance`
running.

| Step | Checked | Result |
|---|---|---|
| Demo seed | Admin lists the six demo drafts, all `DRAFT` | Pass |
| 1. US1 create, retry | Demo Buyer One, Acme Supplies, `0.1 × 1` three times → 201, `DRAFT`, `PO-2026-27-000007`, total `0.3000` (₹0.30 in the editor: `orders.spec.ts`), `ETag: "1"`; the same request with the same `Idempotency-Key` → 201, the same order and number; the same key with another body → `409 IDEMPOTENCY_KEY_REUSED` | Pass |
| 2. US2 database guard | as `po_app`: `UPDATE purchase_orders SET total = 1` → `permission denied for table purchase_orders`; as `po_owner` with an actor context → `PO005: DERIVED_VALUE_READ_ONLY` (detail: total and open_line_count are derived from its lines); stored totals = the sum of their lines for every order | Pass |
| 3. US3 two editors | save with `If-Match: "1"` → 200, `ETag: "2"`, total `1.2000`; a second save with `"1"` → `409 VERSION_CONFLICT`; a save that changes nothing keeps `"2"`; no `If-Match` → `400`, `header.if-match` `VERSION_REQUIRED`. The message and Reload order in two tabs: `orders.spec.ts` | Pass |
| 4. US4 delete | delete with a reason → 204; the owner reads it → 404; the Admin's timeline → `PO_DRAFT_DELETED` (reason "Raised twice"), `PO_CREATED`; the owner's timeline → 404; the next create takes `PO-2026-27-000009` after the deleted `…000008`. The dialog: `orders.spec.ts` | Pass |
| 5. US5 filters | vendor (3 orders, all Acme), status `DRAFT`, PO prefix in lower case `po-2026-27-0000` (5, all matching), created today (5) and in 2020 (0); a reversed range → `400`, `query.createdTo` `OUT_OF_RANGE`. URL state on reload: `orders-list.test.tsx` | Pass |
| 6. US6 visibility | Demo Buyer Two: the first Buyer's order → 404, edit → 404, list holds only their own (3); Approver: list → 200, total 0, a draft → 404; Admin: every draft listed (8), edit → `403 FORBIDDEN` "Admins can view orders but not change them.", create → `403 FORBIDDEN`; anonymous → `401 UNAUTHENTICATED`. Read-only detail for the Admin: `orders.spec.ts` | Pass |
| 7. Body limit | `scripts/smoke-order-limits.sh` against the stack: the largest valid order raw and escaped → 201 through the edge; `ORDER_BODY_LIMIT_BYTES + 1` on `/api/orders` and `BODY_LIMIT_BYTES + 1` on `/api/vendors` → the edge's 413. Through the API alone: `order-body-limit` tests in `npm test` | Pass |
| Reconciliation | `backend/src/db/reconciliation.sql` as `po_app` after the seed and steps 1–7 → 0 rows | Pass |
| Automated | `npm test`: contracts 106, backend 966, frontend 373, scripts 100, all passed; lint, typecheck, ID check clean; `npm run test:plans`: 10 passed (order service timings with the other fixtures seeding alongside: create p95 133 ms, replace 147 ms, busiest Buyer's page 11 ms); `npm run plans:orders`: 96 plans, no drift; `npm run e2e:local`: 38 passed, 1 skipped (the editor benchmark excluded, below); `npm run check:traceability`: ok | Pass |

Notes:
- Step 2: the quickstart says "as `po_owner` → `PO005`". A write with no actor context
  is refused first with `ACTOR_CONTEXT_REQUIRED` (the audit guard); with
  `app.actor_txid` and `app.actor_type` set, as the app sets them, the write reaches the
  derived-value guard and fails with `PO005`.
- Step 1 ran after the demo seed's six drafts, so the first new number is `…000007`.
- Not passing: the editor benchmark (`frontend/e2e/order-editor-perf.spec.ts`, T066). On
  this laptop (power-saver profile) at 4× CPU throttling, after the editor work in this
  slice: opened in 342–646 ms (target 1,000) and add/remove p95 62–91 ms (target 100),
  but keystroke p95 55–84 ms (target 50). A plain input on the login page measures p95
  45–47 ms on the same machine and settings. The spec is not committed; the target is
  unchanged.
