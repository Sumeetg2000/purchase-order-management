# Implementation Plan: Slice 6 — Goods receipt and concurrency

**Branch**: `007-goods-receipt` | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-goods-receipt/spec.md`

## Summary

The owner of an approved order records goods received per line, partly and across
several deliveries, one or many lines per command, all or nothing; received never exceeds
ordered on any path, however requests interleave:
- a receipt document (owner, 2026-11-25): `goods_receipts` (one immutable row per
  command: order, date, recorder, note) and `goods_receipt_lines` (one per line it
  covers), composite keys keeping every line on the receipt's order
- each line's received quantity stored, maintained by a statement-level trigger on
  receipt inserts, guarded, and in reconciliation (INV-3), like `open_line_count`
  **[steer]**
- the database refuses received > ordered on every insert path, receipts on non-approved
  orders, receipts not by the owner, dates before approval, dates more than a day past
  its India date (backstop), and any receipt change (D12–D17)
- lock order: key → order → lines (id asc) → the caller's user row **[steer]**
- set-based writes: one statement for the receipt and its lines (a CTE), one for their
  audit entries **[steer]**
- slice 5's deferrals: `ORDER_FULLY_RECEIVED` on cancel (service and D10), the received
  summary in the cancel dialog, the cancel-vs-receipt race, the Admin's open-order counts
- receipt badges in every order list, derived per page row (no stored counter) **[steer]**

**A full receipt doesn't change the order's status**: it stays `APPROVED`; progress is
derived (ADR-0001 unchanged on this point; research R4).

Decisions in [research.md](research.md) (R1–R13, sign-offs in R13); tables in
[data-model.md](data-model.md); schemas, operations and OpenAPI diff in
[contracts/api.md](contracts/api.md), with [errors.md](contracts/errors.md) and
[ui.md](contracts/ui.md).

## Technical Context

**Language/Version**: TypeScript 6 (`strict`) on Node.js 24; SQL for PostgreSQL 17

**Primary Dependencies**: the slice 0–5 stack; no new dependency.

**Storage**: PostgreSQL 17. Migration `0016_receipts`: tables `goods_receipts` and
`goods_receipt_lines`, their keys and indexes, a unique key on `order_lines`, the receipt
triggers, 1 function, 1 guard, D10 extended,
`idempotency_keys` CHECK widened, reconciliation INV-3.

**Testing**: Vitest + Supertest + Testcontainers PostgreSQL 17 (no DB mocks): receipts
service and route; integrity attacks (D12–D17, the `received_quantity` guard, as `po_app`
and as a privileged role, ending in reconciliation); concurrency (R11's eight races, 10
runs each); authorization matrix (receipt row × callers × states; the receipts read);
state machine (receipt refused per state; T10's fully-received guard); trigger
efficiency (0 total recomputes, 1 open-line recompute per receipt statement); query
count (7 statements for 1 or 500 lines); audit payload; property-based invariant test
over random receipt sequences; plan and timing tests; Testing Library + vitest-axe +
MSW; Playwright + axe.

**Target Platform**: the existing docker compose stack; no config or `.env` change.

**Project Type**: web application (API + SPA), npm workspaces.

**Performance Goals**: ADR-0012: single-line receipt p95 ≤ 150 ms, 500-line receipt p95
≤ 500 ms, 50 timed runs after 3 warm-up; every page-1 list plan still stops at its page
with the badge probe; receipt history page 1 and its count, and the Admin's counts at the busiest Buyer
planned.

**Constraints**: every receipt rule in the database; `users` locked last; contract
additive but for two new `FieldCode` values (the `breaking` label expected); no stored
progress counter unless a plan fails (owner first).

**Scale/Scope**: 2 new operations, 4 changed reads; 1 table, 4 indexes; 6 SQLSTATEs; 3
registry codes and 2 field codes live; 1 audit event (payload defined); 1 form, 2
dialogs changed or added, 1 section, 1 badge.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this slice complies | Status |
|---|---|---|
| I. Derived-value integrity | INV-3/INV-4/INV-6 held by the receipt trigger, the guard and the CHECK, for every role; reconciliation gains INV-3 and runs after attacks, seed and fixture | Pass |
| II. State machine | No new transition; receipts only on `APPROVED` (service and D12); T10's fully-received guard live (service and D10) | Pass |
| III. Authorization | Route role first (pure Approver, Admin `403 FORBIDDEN`), then 404 → `NOT_ORDER_OWNER` → caller re-checked under lock; owner-only in the database too (D13); matrix receipt row amended 2026-11-24 | Pass |
| IV. Audit | One `GOODS_RECEIPT_RECORDED` per receipt in the same transaction, both dates; append-only receipts (D16) | Pass |
| V. Concurrency | Lock order key → order → lines → user; eight races with business outcomes; idempotent retries; no `If-Match` by design (ADR-0006) | Pass |
| VI. API contract | Zod first; OpenAPI additive but for two `FieldCode` values (label expected); codes from the registry; strict body; read-only fields refused | Pass |
| VII. Performance | Set-based writes, statement-level triggers; 0 total recomputes per receipt; list, history and count plans; timings at 50/3 | Pass |
| VIII. Test-first | Each story's tests first, seen failing against Testcontainers; attack tests on part 1 before part 2 | Pass |
| IX. Operability and security | No new config, secret or role; CSRF on the new write; no `.env` change | Pass |
| X. Brief binding | §3.6, §4, §8 receipts; matrix change signed off 2026-11-24; ADR updates listed for review | Pass |
| XI. Code clarity | `receipts/` area (routes → service → repository); constants once, SQL copies pinned; IDs only in test names | Pass |
| XII. Simplicity | One table; no progress counter; no new dependency; reuses idempotency, ConfirmDialog, pagination | Pass |
| XIII. Frontend | ConfirmDialog with ADR-0018 text, safe focus, one request; errors by `code`; axe | Pass |

**Gate result (pre-research)**: PASS.

**Re-check after Phase 1 design**: PASS, no deviation. ADR updates are written only
after the owner signs off research R13: ADR-0001 (D10's fully-received branch live; no
status change on full receipt), ADR-0003 (D12–D17, the guard, the split recompute,
INV-3), ADR-0004 (precedence note for receipts), ADR-0006 (receipt lock row), ADR-0007
(field codes, error details), ADR-0012 (fixture receipt mix), ADR-0016 (payload,
`openOrders`).

## Project Structure

### Documentation (this feature)

```text
specs/007-goods-receipt/
├── spec.md, checklists/requirements.md
├── plan.md            # this file
├── research.md        # R1–R13
├── data-model.md      # migration 0016, triggers, rules, audit, fixture
├── quickstart.md
├── contracts/         # api.md, errors.md, ui.md
└── tasks.md           # /speckit-tasks
```

### Source Code (new and changed)

```text
packages/contracts/src/
├── receipts.ts                  # constants, progress enum
├── schemas/receipts.ts          # body, response, page item
├── schemas/orders.ts            # line received/outstanding, progress, list item
├── schemas/admin-users.ts       # openOrders
├── errors.ts                    # DATE_IN_FUTURE, DATE_BEFORE_APPROVAL; error details
└── operations.ts                # + recordReceipt, listOrderReceipts
backend/prisma/migrations/0016_receipts/migration.sql
backend/prisma/schema.prisma
backend/src/
├── receipts/routes.ts, service.ts, repository.ts    # new area
├── orders/repository.ts         # read and list fields, badge probe
├── approvals/service.ts, repository.ts               # cancel: fully received
├── admin-users/service.ts       # openOrders
├── idempotency/repository.ts    # recordReceipt
├── audit/events.ts, write.ts    # GOODS_RECEIPT_RECORDED, writeAuditBatch
├── db/errors.ts, reconciliation.sql
└── migrate/seed-demo.ts         # receipt states through the service
backend/tests/
├── integration/receipts*.test.ts, authorization-matrix, state-machine, audit, route-table
├── integrity/receipt-attacks.test.ts, reconciliation.test.ts, property tests
├── concurrency/receipts.test.ts
└── plans/orders-fixture.ts (receipt mix), orders.plan.test.ts, receipts.plan.test.ts,
    orders.timing.test.ts (+ receipts)
docs/query-plans/orders/*.txt    # re-committed list pages; receipts-history; admin counts
frontend/src/
├── pages/orders/OrderDetail.tsx, ReceiptForm.tsx, ReceiptDialog.tsx,
│   ReceiptsSection.tsx, CancelDialog.tsx, OrdersList.tsx, receipt-progress.ts
├── pages/admin/RoleDialog.tsx, UserDialogs.tsx
└── errors/messages.ts
frontend/e2e/receipts.spec.ts
```

**Structure Decision**: receipts get their own area (`receipts/`): a new command with its
own route, service and repository, called by nobody else; `orders/` gains only read
fields; cancel's fully-received check stays in `approvals/`.

## Story order for `/speckit-tasks`

1. **Foundational**: migration 0016 part 1 (table, grants, keys, indexes, CHECK widened);
   contracts (constants, schemas, operations, codes); audit event; web messages.
2. **Database rules first** (US3/US4 base): attack and trigger-efficiency tests seen
   failing on part 1, then part 2 (triggers, guard, D10 branch, reconciliation INV-3).
3. **US1 Partial receipts** (P1): service, route, reads, history; Receipts section.
4. **US2 Multi-line, all or nothing** (P1): validation, over-receipt naming, set-based
   writes, query count; Record receipt form and dialog.
5. **US3 Who and when** (P1): matrix receipt row × callers × states; caller re-check.
6. **US4 Concurrency** (P1): R11 races 1–3, 6–8.
7. **US5 Cancel with receipts** (P2): fully-received refusal, summary, races 4–5.
8. **Lists badge** (FR-021a): probe, re-committed plans (stop and show the owner if any
   fails).
9. **US6 Admin counts** (P3): API field, count plan, dialogs.
10. **Polish**: timings, fixture mix, demo seed, e2e (partial → full receipt), traceability
   (FR-RCV-01–04, FR-LCK-02, FR-SM-01, FR-OWN-01, FR-RPT-03, FR-PO-03, NFR-AUD-01,
   NFR-CON-01/03, NFR-PERF-03, NFR-FE-07/09), quickstart run, reviews.

Each story: tests first, seen failing against real PostgreSQL, then code.

## Complexity Tracking

No constitution violation to justify.
