# Quickstart: Slice 5 — validate cancel and the remaining locks

Prerequisites: the isolated e2e stack (`npm run e2e:local` brings it up), demo seeding on.
Results go to `quickstart-results.md` at slice end.

| # | Scenario | How | Expected |
|---|---|---|---|
| 1 | Cancel | as the Demo Approver, cancel a demo Buyer's approved order with a reason | `200` `CANCELLED`, version +1; `cancellation` names the Approver; one `PO_CANCELLED` (round, reason, each line ordered and 0 received) |
| 2 | Auto-approved | cancel an order the submit auto-approved | same as 1 |
| 3 | Who may cancel | pure Buyer (owner and other), Admin, Buyer+Approver on own order, no-role user | `403 FORBIDDEN` "Only Approvers can cancel orders."; `403 FORBIDDEN` "Admins can view…"; `403 SELF_APPROVAL`; `403 NO_ROLE_ASSIGNED` |
| 4 | Wrong state | cancel a draft (Approver), a pending, a rejected and a cancelled order | `404`; `409 INVALID_STATE_TRANSITION` ×3 with `action: CANCEL` |
| 5 | Reason and version | blank reason, whitespace reason, 501 characters, no `If-Match`, stale `If-Match` | `TOO_SHORT`, `TOO_SHORT`, `TOO_LONG`, `VERSION_REQUIRED`, `409 VERSION_CONFLICT` |
| 6 | Lock codes | as the owner: `PATCH`, `DELETE`, submit, withdraw the cancelled order | `409 ORDER_LOCKED` "…cancelled and is closed." ×2; `409 INVALID_STATE_TRANSITION` ×2 |
| 7 | Database lock | as `po_app` in `psql` on a cancelled order: its `version`, `cancel_reason`, a line, a step, delete it; set an approved order `CANCELLED` with no record; cancel as the owner's actor | `PO018`, `PO018`, `PO006`, `PO012`, `PO010`, `23514`, `PO016` |
| 8 | Owner gone | Admin deactivates a demo Buyer with an approved order; the Approver opens it, then cancels | marker with both sentences; cancel succeeds |
| 9 | Visibility | owner, another Buyer, Admin read the cancelled order; list filtered to Cancelled | owner and Admin read it; other Buyer `404`; filter shows only readable cancelled orders |
| 10 | Gate | `set -o pipefail; npm test 2>&1 \| tail -40`; `npm run test:plans`; `npm run e2e:local` | green; reconciliation 0 rows; no plan changed except the new Cancelled cases |

Contracts: [api.md](contracts/api.md), [errors.md](contracts/errors.md),
[ui.md](contracts/ui.md). Data: [data-model.md](data-model.md).
