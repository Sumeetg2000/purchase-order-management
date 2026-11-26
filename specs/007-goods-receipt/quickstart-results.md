# Quickstart results: Slice 6 — Goods receipt

Run 2026-11-26 against a clean, isolated stack: the e2e compose project (`po-e2e`, image
tag `e2e`, its own ports and TLS edge, a throwaway env file from `scripts/ci-env.sh` with
`SEED_DEMO_DATA=true`), removed with its volumes afterwards and the env file deleted, so
the default stack was never touched. Scenarios 1–7 and 9 were driven over HTTP through the
edge (`/api`) as the demo Buyers, the Demo Approver, an Admin made with the operator CLI
(`admin:create`, set-password → 204) and a self-signup user verified through Mailpit and
given no role; scenario 8 through `psql` in the db container (`SET ROLE po_app`, the
owner's actor context set as the app sets it). The driver is kept locally, not committed
(`.local/quickstart/`).

**Result: 48 checks, 48 passed.** The first run on its own stack passed 39 of 48: the
9 failures were the driver's own. Scenario 8's errors went to psql's stderr, which the
driver dropped because psql exits 0 on a failed statement. And the driver expected one
audit entry per receipt where there is one per receipt line, which is what the quickstart
says. After one fix to the driver, the stack was recreated empty and the whole run
repeated.

| # | Checked | Result |
|---|---|---|
| Demo seed | per demo Buyer: the auto-approved order fully received (two receipts), the step-approved one partly, the cancelled one partly before its cancel (integration test; the stack seeded the same) | Pass |
| 1. Partial, then full | one line of 100: receive 40 → `201`, 40 received / 60 outstanding, `PARTIALLY_RECEIVED`; receive 60 → `201`, 100 / 0, `FULLY_RECEIVED`; status still `APPROVED`, version unchanged (v2); two `GOODS_RECEIPT_RECORDED`, each with its receipt date | Pass |
| 2. Multi-line, all or nothing | three lines, the second over its outstanding → `409 RECEIPT_EXCEEDS_OUTSTANDING` naming only that line (position 1, outstanding 10, requested 11), nothing written; the valid three-line command → `201`, one receipt with 3 lines, 3 entries (one per line, each naming the receipt); the receipt read alone → its 3 lines; under another order's path → `404` | Pass |
| 3. Validation | tomorrow (IST) → `DATE_IN_FUTURE`; before approval → `DATE_BEFORE_APPROVAL`; quantity 0 → `OUT_OF_RANGE`; unknown line → `LINE_NOT_FOUND`; duplicate line → `DUPLICATE_LINE_ID`; no `Idempotency-Key` → `REQUIRED`; each `400 VALIDATION_FAILED` | Pass |
| 4. Who may receive | another Buyer → `404`; Demo Buyer Two made Buyer+Approver by the Admin → `403 NOT_ORDER_OWNER` "Only the buyer who raised this order can do that." (then set back to Buyer); pure Approver → `403 FORBIDDEN` "Approvers can't record receipts. The order's Buyer records them."; Admin → `403 FORBIDDEN` "Admins can view orders but not change them."; no role → `403 NO_ROLE_ASSIGNED`; anonymous → `401` | Pass |
| 5. Wrong state | the owner on a draft, a pending, a rejected and a cancelled order → `409 ORDER_NOT_RECEIVABLE` ×4 | Pass |
| 6. Idempotency | same key and body twice → `201` both, the same receipt; same key, other body → `409 IDEMPOTENCY_KEY_REUSED`; one receipt added | Pass |
| 7. Cancel with receipts | a partly received order → `200 CANCELLED`, `PO_CANCELLED` with each line's ordered and received quantity; a fully received one → `409 ORDER_FULLY_RECEIVED` | Pass |
| 8. Database | as `po_app` with the owner's actor: over-receive → `PO022`; on a cancelled order → `PO020`; as another user's actor → `PO021`; dated before approval → `PO024`; 2 days ahead → `PO025`; update and delete a receipt, write `received_quantity` → `42501` (the privilege refuses before the trigger, as the quickstart allows); reconciliation → 0 rows | Pass |
| 9. Lists and admin | the Buyer's, the Approver's and the Admin's lists carry the same progress (fully received; cancelled, partly received); the Admin's open-order counts for Demo Buyer One match the Buyer's own list (draft 5, pending 2, approved with open lines 2). The deactivate dialog's wording: component tests (`admin-users-page.test.tsx`) | Pass |
| 10. Gate | `npm run gate` (2026-11-26, commit d587787): contracts 140, backend 1268, web 496, scripts 107, e2e 48 (the 3 receipt tests among them), no leaks; `check:traceability` ok. Plans and timings: 7 plan tests on the 100,000-order fixture; receipt timings p95 77 ms (500 lines, target 500) and 20 ms (one line, target 150) | Pass |

**SC-006** (three lines, from opening the order to the updated quantities, under a
minute), as observed: scenario 2's valid three-line command took 27 ms through the API,
and in the browser walkthrough (`frontend/e2e/receipts.spec.ts`: open the order, Record
receipt, a quantity per line, Continue, Record receipt, the updated quantities shown) the
whole receipt test finished in seconds. Recorded as observed, not timed (tasks T043).

**SC-007**: axe found nothing on the receipt form, the receipt dialog, the order page with
its receipts, the list with badges and the cancel dialog with receipts (e2e, Chromium).

## Slice-end review

- `/security-review`: no finding. Checked: who may record and read receipts (route roles,
  owner and state re-checked under the lock, the database's own D12–D16), receipt ids
  scoped to their order, idempotency per user and order, bound parameters throughout,
  the SECURITY DEFINER functions' pinned search paths, `po_app`'s column grants, and what
  responses and problem details carry.
- `/code-review`: one important finding, fixed: a refused over-receipt made the receipt
  dialog and form re-render in a loop (the dialog's effect re-ran on each new callback).
  Five nits: a corrected quantity stayed marked invalid (fixed); a requirement ID in a
  code comment (removed); the gate exited 1 instead of the failing check's status
  (fixed); the dated "before approval" message from errors.md was never shown (now shown
  in the receipt dialog); Received and Outstanding columns on pending and rejected orders
  (first kept, as ui.md asked; then, on the owner's review, shown only on approved and
  cancelled orders, and ui.md changed to match).
- Constitution pass: derived values (received quantities, the open-line count) are
  written only by the database and reconciled; every receipt path is tested first against
  real PostgreSQL; layering holds (routes → service → repository); new numbers and
  decisions are in ADR-0006, ADR-0011 and ADR-0016.
