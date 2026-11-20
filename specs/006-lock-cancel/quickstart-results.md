# Quickstart results: Slice 5 — Cancel approved orders, and the remaining locks

Run 2026-11-20 against a clean, isolated stack: the e2e compose project (`po-e2e`, image
tag `e2e`, its own ports and TLS edge, a throwaway env file from `scripts/ci-env.sh` with
`SEED_DEMO_DATA=true`), removed with its volumes afterwards and the env file deleted, so
the default stack was never touched. Steps 1–6, 8 and 9 were driven over HTTP through the
edge (`/api`) as the demo Buyers, the Demo Approver and an Admin made with the operator
CLI (`admin:create`, set-password → 204); step 7 through `psql` as `po_app` (`SET ROLE`)
with an actor context set as the app sets it.

**Result: 47 checks, 47 passed.** A first run on the same stack failed 11 checks on
driver errors (psql's verbosity passed as a backslash command inside `-c`; the expected
count of cancelled orders; `SET ROLE`'s own output read as a reconciliation row); after
fixing the driver, the stack was recreated empty and the whole run repeated.

| Step | Checked | Result |
|---|---|---|
| Demo seed | each demo Buyer has one cancelled order, made through the cancel service | Pass |
| 1. Cancel | Demo Approver cancels Demo Buyer One's step-approved order → 200 `CANCELLED`, version +1; `cancellation` names the Demo Approver and the reason; one `PO_CANCELLED` as `USER`/`APPROVER` with the round, the reason and each line (0 received) | Pass |
| 2. Auto-approved | an order the submit auto-approved → cancelled, 200 | Pass |
| 3. Who may cancel | owner Buyer and other Buyer → `403 FORBIDDEN` "Only Approvers can cancel orders."; Admin → `403 FORBIDDEN` "Admins can view orders but not change them."; Demo Buyer Two made Buyer+Approver by the Admin, on their own order → `403 SELF_APPROVAL` "You can't cancel an order you raised."; anonymous → 401. No-role callers: the matrix test (no-role signup needs a verified mailbox) | Pass |
| 4. Wrong state | a draft → 404 (unreadable to an Approver); pending, rejected and cancelled → `409 INVALID_STATE_TRANSITION`, `orderState.action` `CANCEL` | Pass |
| 5. Reason and version | blank and whitespace → `TOO_SHORT`; 501 characters → `TOO_LONG`; no `If-Match` → `VERSION_REQUIRED`; stale → `VERSION_CONFLICT`; the order unchanged | Pass |
| 6. Lock codes | as the owner on the cancelled order: `PATCH` and `DELETE` → `409 ORDER_LOCKED` "This order was cancelled and is closed."; submit and withdraw → `409 INVALID_STATE_TRANSITION` | Pass |
| 7. Database lock | cancelled order: `version` → `PO018`, `cancel_reason` → `PO018`, a line → `PO006`, a step → `PO012`, delete → `PO010`; an approved order set `CANCELLED` with no record → `23514`; a cancel as the owner's actor → `PO016`; a rejected order's `version` → `PO018` | Pass |
| 8. Owner gone | the Admin deactivates Demo Buyer Two with an approved order; the Approver reads `ownerCanAct: false` (the marker: `order-cancel-detail.test.tsx`); the cancel succeeds; Demo Buyer Two restored | Pass |
| 9. Visibility | the owner and the Admin read the cancelled order, another Buyer gets 404; the owner's timeline holds `PO_CANCELLED`; the Cancelled filter shows each Buyer only their own and the Approver and the Admin all five; no cancelled order in the queue | Pass |
| Reconciliation | `backend/src/db/reconciliation.sql` as `po_app` after steps 1–9 → 0 rows | Pass |
| 10. Gate | `npm test`: contracts 126, backend 1134, web 456 passed (on the balanced power profile; on power-saver 19 web and 2 timing-sensitive backend tests time out, as recorded before); `npm run test:plans`: 13 passed (submit p95 42 ms, approve 37 ms, cancel 34 ms); `npm run plans:orders`: 20 new Cancelled plans, none changed; `npm run e2e:local`: 45 passed, 1 skipped (the editor benchmark, on demand); `check:traceability` and `check:ids`: ok | Pass |
