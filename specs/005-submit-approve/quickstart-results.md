# Quickstart results: Slice 4 — Submission, routing and decisions

Run 2026-11-19 against a clean, isolated stack: the e2e compose project (`po-e2e`, image
tag `e2e`, its own ports and TLS edge, a throwaway env file from `scripts/ci-env.sh` with
`SEED_DEMO_DATA=true`), removed with its volumes afterwards and the env file deleted, so
the default stack was never touched. The stack had first run `frontend/e2e/approvals.spec.ts`
(5 passed). Steps 2–3 and 5–9 were driven over HTTP through the edge (`/api`) as the demo
Buyers, the Demo Approver and an Admin made with the operator CLI (`admin:create`,
set-password → 204); steps 1 and 9's policy commands through `docker compose exec api npm
run admin`; step 4 through `psql` as `po_app` with an actor context set as the app sets it.

**Result: 37 checks, 36 passed first time;** the 37th (step 8's timeline order) failed on
a script error and passed when checked against the right event name (below). `api`, `db`, `mailpit`, `web` and `tls` healthy; `maintenance` running.

| Step | Checked | Result |
|---|---|---|
| Demo seed | Per demo Buyer: three drafts, and one pending, auto-approved, step-approved, rejected and withdrawn order; the seeded `REJECTED` order used in step 3 and the seeded pending order in step 9 | Pass |
| 1. Seed policy | `policy:show` → `Approval policy version 1, effective …`, `tier 1: above 100000.0000` | Pass |
| 2. Boundary routing | Demo Buyer One: ₹1,00,000.00 → `APPROVED`, timeline `PO_SUBMITTED` (USER) and `PO_AUTO_APPROVED` (SYSTEM); ₹1,00,000.01 → `PENDING_APPROVAL`, one `OPEN` step | Pass |
| 3. Lock codes | `PATCH` the approved order → `409 ORDER_LOCKED` "…approved and locked."; the pending one → `409 ORDER_PENDING_APPROVAL`; the seeded rejected one → `409 ORDER_LOCKED` "…rejected and is closed…" | Pass |
| 4. Database lock | as `po_app`: a line of the approved order → `PO006`; the pending order's vendor → `PO015`; its `submitted_at` → `PO015`; a decided step → `PO012`; the pending order set `APPROVED` → `UPDATE 1`, then `PO014` at `COMMIT` | Pass |
| 5. Queue and approve | the Demo Approver's queue holds the ₹1,00,000.01 order; approve → 200 `APPROVED`; it leaves the queue and the count drops by one; `APPROVAL_STEP_APPROVED` (APPROVER) in the timeline. The nav count in the browser: `approvals.spec.ts` | Pass |
| 6. Self-approval | the Admin makes Demo Buyer Two a Buyer+Approver; their ₹1,50,000 order → pending, absent from their own queue (which holds others' orders); approving it → `403 SELF_APPROVAL` | Pass |
| 7. Owner inactive | the Admin deactivates Demo Buyer One with a ₹1,50,000 order pending; the queue item has `ownerCanAct: false`; approve → `409 ORDER_OWNER_INACTIVE`; reject (reason) → 200 `REJECTED`; Demo Buyer One reactivated for steps 8–9. The marker in the browser: `approval-queue-page.test.tsx`, `approve-order-dialog.test.tsx` | Pass |
| 8. Withdraw and re-route | ₹1,50,000 submitted → withdraw (reason) → `DRAFT`; edit to ₹90,000 → total `90000.0000`; submit → round 2, `AUTO_APPROVED`; `PO_WITHDRAWN` lists the one voided step; timeline, newest first: `PO_AUTO_APPROVED, PO_SUBMITTED, PO_EDITED, PO_WITHDRAWN, PO_SUBMITTED, PO_CREATED` | Pass |
| 9. Policy change | `policy:set --tier1 200000` → `version 2, tier 1 above 200000.0000`; again → `unchanged`, exit 0; `--tier1 0` → exit 1 `INVALID_ARGUMENT`; ₹1,50,000 submitted → `APPROVED` under version 2; the seeded pending order still `PENDING_APPROVAL` under version 1; `GET /approval-policy` → version 2 | Pass |
| Reconciliation | `backend/src/db/reconciliation.sql` as `po_app` after steps 1–9 → 0 rows | Pass |
| 10. Gate | `npm test`: contracts 121, backend 1092, web 417 passed; `npm run test:plans`: 13 passed (create p95 48 ms, replace 75 ms, submit 31 ms, approve 30 ms, busiest Buyer's page 3 ms, queue page 3 ms); `npm run plans:orders`: no plan changed; `npm run e2e:local`: 43 passed, 1 skipped (the editor benchmark, on demand); `npm run check:traceability`: ok | Pass |

Notes:
- Step 8: the driver first expected `PO_UPDATED` between the withdraw and the resubmit;
  the event an edit records is `PO_EDITED` (ADR-0016's catalogue), and the timeline was
  in order. The check was a script error, not a product one.
- Step 10: one web run of the full gate failed a single test (the Reject dialog's
  content, focus and axe test) under the backend's load; it passed alone three times and
  in a full web rerun (417 passed). No cause found; noted here in case it recurs.
