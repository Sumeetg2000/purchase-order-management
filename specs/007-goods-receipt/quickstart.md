# Quickstart: Slice 6 — validate goods receipt

Prerequisites: the isolated e2e stack (`npm run e2e:local` brings it up), demo seeding on.
Results go to `quickstart-results.md` at slice end.

| # | Scenario | How | Expected |
|---|---|---|---|
| 1 | Partial, then full | as a demo Buyer, on an approved one-line order of 100: receive 40, then 60 | `201` each; 40/60 then 100/0; progress partly → fully; status still `APPROVED`; version unchanged; 2 `GOODS_RECEIPT_RECORDED` with both dates |
| 2 | Multi-line, all or nothing | three lines, one over its outstanding; then a valid command | `409 RECEIPT_EXCEEDS_OUTSTANDING` listing that line (and every other over its outstanding), nothing written; then 3 receipts, 3 entries |
| 3 | Validation | date tomorrow (IST), date before approval, quantity 0, unknown line, duplicate line, no `Idempotency-Key` | `DATE_IN_FUTURE`, `DATE_BEFORE_APPROVAL`, `OUT_OF_RANGE`, `LINE_NOT_FOUND`, `DUPLICATE_LINE_ID`, `REQUIRED` |
| 4 | Who may receive | another Buyer, Buyer+Approver non-owner, pure Approver, Admin, no-role, anonymous | `404`, `403 NOT_ORDER_OWNER`, `403 FORBIDDEN` (Approvers message), `403 FORBIDDEN` (Admins message), `403 NO_ROLE_ASSIGNED`, `401` |
| 5 | Wrong state | the owner on a draft, pending, rejected, cancelled order | `409 ORDER_NOT_RECEIVABLE` ×4 |
| 6 | Idempotency | same key and body twice; same key, other body | one receipt, same response; `409 IDEMPOTENCY_KEY_REUSED` |
| 7 | Cancel with receipts | cancel a partly received order; then try a fully received one | `200` with `PO_CANCELLED` received per line; `409 ORDER_FULLY_RECEIVED` |
| 8 | Database | as `po_app` in `psql`: over-receive, receipt on a cancelled order, as another user's actor, dated before approval, dated 2 days ahead, update and delete a receipt, write `received_quantity` | `PO022`, `PO020`, `PO021`, `PO024`, `PO025`, `PO023` ×2, `PO005` (or a privilege error first) |
| 9 | Lists and admin | each role's order list; the Admin opens a demo Buyer's detail and the deactivate dialog | badges as R8; open-order counts match |
| 10 | Gate | `set -o pipefail; npm test 2>&1 \| tail -40`; `npm run test:plans`; `npm run e2e:local` | green; reconciliation 0 rows; list plans re-committed and still stopping at the page |

Contracts: [api.md](contracts/api.md), [errors.md](contracts/errors.md),
[ui.md](contracts/ui.md). Data: [data-model.md](data-model.md).
