# Implementation Plan: Slice 5 — Cancel approved orders, and the remaining locks

**Branch**: `006-lock-cancel` | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-lock-cancel/spec.md`

## Summary

An Approver cancels an approved order they don't own, with a reason and its version
(ADR-0001 T10); the order becomes `CANCELLED`, final, and the database refuses every
change to it:
- the cancel record as three columns on `purchase_orders`, all set iff cancelled, set
  once (owner steer)
- rules D9 (a rejected or cancelled order never changes), D10 (the cancel columns move only with the
  cancel transition, which changes nothing else), D11 (by the acting user, never the
  owner), and D1 extended to `CANCELLED`
- lock order: order, then the acting Approver's `users` row, re-checked under lock as in
  approve
- `POST /orders/:id/cancel`; `ORDER_LOCKED` for cancelled edits and deletes;
  `INVALID_STATE_TRANSITION` with action `CANCEL`
- web: Cancel dialog, Cancellation section, owner-can't-act marker on approved orders
- first task: submit and approve timings at 50 timed runs after 3 warm-up (FR-019)

Decisions in [research.md](research.md) (R1–R10); tables in
[data-model.md](data-model.md); schemas, operation and OpenAPI diff in
[contracts/api.md](contracts/api.md), with [errors.md](contracts/errors.md) and
[ui.md](contracts/ui.md).

## Technical Context

**Language/Version**: TypeScript 6 (`strict`) on Node.js 24; SQL for PostgreSQL 17

**Primary Dependencies**: the slice 0–4 stack; no new dependency.

**Storage**: PostgreSQL 17. `purchase_orders` gains `cancelled_by`, `cancelled_at`,
`cancel_reason` with two CHECKs; one transition row; one guard trigger; the consistency
function replaced; one foreign-key index (migration `0015_cancel`).

**Testing**: Vitest + Supertest + Testcontainers PostgreSQL 17 (no DB mocks): state
machine (T10 allowed, and refused from each other state), locked orders (the cancelled
column of every write path), integrity attacks (D9–D11 and D1's cancelled branch as
`po_app` and as a privileged role, ending in reconciliation), concurrency (R4's five
races, 10 runs each), authorization matrix (cancel row × 8 callers × 5 states; read rows
for `CANCELLED`), audit payload, plan and timing tests; Testing Library + vitest-axe +
MSW; Playwright + axe.

**Target Platform**: the existing docker compose stack; no config change.

**Project Type**: web application (API + SPA), npm workspaces.

**Performance Goals**: ADR-0012: cancel p95 ≤ 150 ms (the decision target), measured at
50 timed runs after 3 warm-up like submit and approve; every list and count with the
Cancelled filter stops at its page at 100k orders.

**Constraints**: every lock rule in the database; `users` locked last; contract additive;
no new index for the filter unless a plan test fails without it (owner steer).

**Scale/Scope**: 1 new operation, 3 changed reads/writes; 3 columns, 2 CHECKs, 1
trigger, 1 index; 2 SQLSTATEs; 0 registry codes; 1 audit event (payload defined); 1
dialog, 1 page section, 1 marker.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this slice complies | Status |
|---|---|---|
| I. Derived-value integrity | Lines of a cancelled order stay frozen (`PO006`); D9 freezes every column; reconciliation covers `CANCELLED` through D1 and runs after the attack suite and seed | Pass |
| II. State machine | One transition row (T10), tests allowed and refused per state; `CANCELLED` final in the database (D9); the cancel binds to the version (`If-Match`, D10's `version` +1) | Pass |
| III. Authorization | Route role first (pure Buyer and Admin `403`), then under lock the Approver re-check → 404 → `SELF_APPROVAL` → 409; `SELF_APPROVAL` also in the database (D11); matrix cancel row and the R10 cells signed off 2026-11-20 | Pass |
| IV. Audit | `PO_CANCELLED` in the cancel's transaction, actor `USER` acting as `APPROVER`, with round, reason and each line's ordered and received quantity | Pass |
| V. Concurrency | Lock order order → Approver row (ADR-0006 row added); five races with business outcomes; `If-Match` required | Pass |
| VI. API contract | Zod first; additive OpenAPI; no new registry code; strict body reused; body inventory | Pass |
| VII. Performance | Cancelled filter cases added to the committed plans for every scope; timing at 50/3; no index unless a plan fails | Pass |
| VIII. Test-first | Each story's tests first, seen failing against Testcontainers | Pass |
| IX. Operability and security | No new config, secret or role; CSRF on the new write | Pass |
| X. Brief binding | §3.5 cancellation; matrix change signed off; ADR updates listed for review | Pass |
| XI. Code clarity | Cancel in `approvals/` beside approve and reject (shared Approver re-check); constants once, SQL copies pinned; IDs only in test names | Pass |
| XII. Simplicity | Columns, not a table; no new dependency; reuses the reason schema, reload action and ConfirmDialog | Pass |
| XIII. Frontend | ConfirmDialog with ADR-0018 text, safe initial focus; errors by `code`; axe | Pass |

**Gate result (pre-research)**: PASS.

**Re-check after Phase 1 design**: PASS, no deviation. ADR updates written 2026-11-20
after the owner signed off research R10: ADR-0001 (T10 live; D9–D11; fully-received
check arrives with receipts), ADR-0004 (R10 Q2, Q3, Q7), ADR-0006 (cancel's lock row;
receipts lock the order first), ADR-0012 (R10 Q6), ADR-0016 (`PO_CANCELLED` field
names). ADR-0004's cancel row was written with the spec (2026-11-20).

## Project Structure

### Documentation (this feature)

```text
specs/006-lock-cancel/
├── spec.md, checklists/requirements.md
├── plan.md            # this file
├── research.md        # R1–R10
├── data-model.md      # migration 0015, guard, consistency branch, audit payload
├── quickstart.md
├── contracts/         # api.md, errors.md, ui.md
└── tasks.md           # /speckit-tasks
```

### Source Code (new and changed)

```text
packages/contracts/src/
├── orders.ts                    # CANCEL action, transition, cancel FORBIDDEN detail
├── approvals.ts                 # ORDER_LOCKED CANCELLED, SELF_APPROVAL by action, marker text
├── schemas/orders.ts            # order.cancellation; read-only fields
└── operations.ts                # + cancelOrder
backend/prisma/migrations/0015_cancel/migration.sql
backend/prisma/schema.prisma
backend/src/
├── approvals/routes.ts, service.ts, repository.ts   # cancel
├── orders/repository.ts         # read with cancellation
├── db/errors.ts                 # PO018, PO019
├── audit/events.ts              # PO_CANCELLED schema
└── migrate/seed-demo.ts         # one cancelled order per demo Buyer, through the service
backend/tests/
├── integration/approvals-cancel.test.ts, orders-lock.test.ts (cancelled), state-machine,
│   authorization-matrix (cancel row, cancelled reads), route-table, audit
├── integrity/cancel-attacks.test.ts, reconciliation.test.ts
├── concurrency/cancel.test.ts
└── plans/orders-fixture.ts (cancelled mix), orders.plan.test.ts (+ Cancelled cases),
    orders.timing.test.ts (50/3; + cancel)
docs/query-plans/orders/*cancelled*.txt
frontend/src/
├── pages/orders/OrderDetail.tsx, CancelDialog.tsx, CancellationSection.tsx
└── errors/messages.ts
frontend/e2e/cancel.spec.ts
```

**Structure Decision**: cancel joins `approvals/` because it shares approve's Approver
re-check, `lockUsers` and route-level role handling; `orders/` gains only the read field
and the lock message.

## Story order for `/speckit-tasks`

0. **First task (FR-019)**: submit and approve timings at 50 timed runs after 3 warm-up,
   targets unchanged.
1. **Foundational**: migration 0015 part 1 (columns, CHECKs, transition row, index);
   contracts (constants, schema, operation); `PO_CANCELLED` schema; frontend messages.
2. **US3 Locked and final** (P1), first because the others rely on the database rules:
   attack tests seen failing on part 1, then part 2 (guard, D1 branch); `ORDER_LOCKED`
   for cancelled edits and deletes.
3. **US1 Cancel** (P1): service, route, read field, audit; Cancel dialog, Cancellation
   section, owner-can't-act marker.
4. **US2 Who may cancel** (P1): matrix cancel row for every caller and state.
5. **US4 Visibility** (P2): cancelled read, timeline and list rows; Cancelled filter plans.
6. **US5 Concurrency** (P2): R4's races.
7. **Polish**: cancel timing, demo seed, e2e, traceability (FR-LCK-02, FR-LCK-01,
   FR-SM-01, FR-SOD-01, FR-OWN-01), quickstart run, reviews.

Each story: tests first, seen failing against real PostgreSQL, then code.

## Complexity Tracking

No constitution violation to justify.
