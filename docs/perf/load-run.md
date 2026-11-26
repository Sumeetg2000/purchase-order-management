# Load test run

The brief's §8 load test (ADR-0012, amended 2026-11-26): one recorded run of
`npm run load` on the isolated `po-load` stack. Orders were raised through the HTTP
API by about 20 virtual users; their ages were then spread by the guarded age shift
(audit entries keep their real times).

**Result: pass**

- Date: 2026-11-26
- Commit: 1e0cace with the load scripts not yet committed (they are committed with this record)
- Duration: 2 min 36 s
- Dataset: 10,000 orders, 200 vendors, 20 buyers, 2 approvers, 12,612 receipts

## Responses by status

| Status | Count |
|---|---|
| 200 | 12,197 |
| 201 | 22,812 |
| 202 | 22 |
| 204 | 23 |
| timed out | 0 |

## Report timings (p95, 50 timed after 3 warm-up)

| Request | p95 | Target | |
|---|---|---|---|
| report, Admin, page 1 | 10 ms | 200 ms | within |
| report, Admin, one vendor | 17 ms | 200 ms | within |
| report, Admin, over 90 days | 10 ms | 200 ms | within |
| report, a Buyer, page 1 | 9 ms | 200 ms | within |
| vendor summary, Admin | 14 ms | 300 ms | within |

Reconciliation: 0 rows.

Unused indexes: all expected (`scripts/load/expected-unused-indexes.json`).
Listed as unused but used in this run: goods_receipts_pkey, purchase_orders_owner_po_number_idx.

The plan for outstanding orders by age on this data:
[`docs/query-plans/load/outstanding-by-age.txt`](../query-plans/load/outstanding-by-age.txt).
