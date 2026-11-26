# Quickstart: Slice 7 — validate the outstanding report, load test and plans

Prerequisites: the isolated e2e stack, demo seeding on; the local driver in
`.local/quickstart/` (not committed; extended for this slice). Results go to
`quickstart-results.md` at slice end.

| # | Scenario | How | Expected |
|---|---|---|---|
| 1 | Report contents | as the Admin: report page 1 | only approved orders with an open line; demo data: each Buyer's partly received approved order listed, the fully received and cancelled ones not; `asOf` = today's India date; age 0, `DAYS_0_30` |
| 2 | Receipts move it | as a Buyer: receive part of an outstanding order, then the rest | open-line count drops; after the last receipt the order leaves the report and the summary |
| 3 | Filters | vendor; bucket; both; a vendor with nothing outstanding; `ageBucket=SOON`; `vendorId=x`; `colour=red` | narrowed; narrowed; narrowed; empty `200`; `400 INVALID_FORMAT`; `400 INVALID_FORMAT`; `400 UNKNOWN_FIELD` |
| 4 | Scope | Buyer One, Buyer Two, Approver, Admin, no-role, anonymous | own only; own only; all; all; `403 NO_ROLE_ASSIGNED`; `401` |
| 5 | Vendor summary | as the Admin and as a Buyer | one row per vendor with anything outstanding, counts per bucket, oldest approval; Buyer's counts only their own |
| 6 | Ages | the recorded load run (ages only move on the `po-load` stack, by the guarded backdate); the bucket boundaries themselves are pinned by the integration tests' injected clock | the run record shows outstanding orders in every bucket; demo data on this stack: age 0 |
| 7 | Load test | `npm run load` | 10,000 orders, 200 vendors; no 5xx or timeout; reconciliation 0 rows; report and summary p95 recorded against 200/300 ms; unused indexes all in the expected list; `docs/perf/load-run.md` and `docs/query-plans/load/outstanding-by-age.txt` written |
| 8 | Plans | `npm run test:plans`; `npm run plans:orders`; `npm run plans:users` | green; report, summary and admin-list plans committed with no drift |
| 9 | Walkthrough | `npm run check:walkthrough` | every named path exists |
| 10 | Gate | `npm run gate` | green |

Contracts: [api.md](contracts/api.md), [ui.md](contracts/ui.md). Data:
[data-model.md](data-model.md).
