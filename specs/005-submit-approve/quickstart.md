# Quickstart: Slice 4 — validate submission, routing and decisions

Prerequisites: `cp .env.example .env && docker compose up` (demo seeding on), or
`npm run dev`. Results go to `quickstart-results.md` at slice end.

| # | Scenario | How | Expected |
|---|---|---|---|
| 1 | Seed policy | `docker compose exec api npm run admin -- policy:show` | version 1, one tier ₹1,00,000 |
| 2 | Boundary routing | as a demo Buyer, submit drafts totalling ₹1,00,000.00 and ₹1,00,000.01 | first `APPROVED` with `PO_SUBMITTED` + `PO_AUTO_APPROVED` (`SYSTEM`); second `PENDING_APPROVAL`, one open step |
| 3 | Lock codes | `PATCH` each order from step 2, and a rejected one | `409 ORDER_LOCKED` "…approved and locked."; `409 ORDER_PENDING_APPROVAL`; `409 ORDER_LOCKED` "…rejected and is closed…" |
| 4 | Database lock | as `po_app` in `psql`: update a line, the vendor, `submitted_at`, a decided step; set a pending order `APPROVED` | `PO006`, `PO015`, `PO015`, `PO012`, `PO014` at commit |
| 5 | Queue and approve | as the Approver: `/approvals`, approve the pending order | it leaves the queue, nav count drops, `APPROVAL_STEP_APPROVED` in the timeline |
| 6 | Self-approval | as a Buyer+Approver, submit > ₹1,00,000 and try to approve | not in their queue; API `403 SELF_APPROVAL` |
| 7 | Owner inactive | Admin deactivates a Buyer with a pending order; Approver opens the queue and approves | marker shown; `409 ORDER_OWNER_INACTIVE`; Reject succeeds |
| 8 | Withdraw and re-route | submit ₹1,50,000 → withdraw (reason) → edit to ₹90,000 → submit | step `VOIDED`; second round auto-approved; timeline in order |
| 9 | Policy change | `policy:set --tier1 200000`; submit ₹1,50,000 | auto-approved under version 2; step 2's pending order keeps version 1 |
| 10 | Gate | `set -o pipefail; npm test 2>&1 \| tail -40`; `npm run e2e:local` | green; reconciliation 0 rows; plans unchanged against `docs/query-plans/orders/` |

Contracts: [api.md](contracts/api.md), [errors.md](contracts/errors.md),
[ui.md](contracts/ui.md). Data: [data-model.md](data-model.md).
