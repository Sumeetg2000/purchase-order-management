# Implementation Plan: Slice 3 — Draft orders and the integrity suite

**Branch**: `004-draft-orders` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-draft-orders/spec.md`

## Summary

The purchase order as a draft, with a total no code path can make drift (brief §3.2,
§3.3, §6):
- create (PO number, `Idempotency-Key`), read, full-line-set edit with line identity,
  delete with an optional reason; lists with status, vendor, PO-prefix and date filters;
  the order timeline
- `line_total` generated; `total` and `open_line_count` kept by statement-level triggers
  with transition tables; a loud overwrite guard; at least one line; drafts-only line
  changes; an empty status-transition table that slice 4 fills
- PO numbers from a per-FY counter row updated at the end of the create's transaction:
  only deleted drafts leave gaps
- exact money through one `big.js` module shared by the API and the web app
- the integrity attack suite ending in the reconciliation query; plans at 100k orders and
  about 1M lines
- the web app's order list, 500-line editor, detail with timeline, delete dialog, and the
  vendor dialog's draft count

Design choices are in [research.md](research.md) (R1–R12), tables in
[data-model.md](data-model.md), and the reviewed Zod schemas, operations and OpenAPI diff
in [contracts/api.md](contracts/api.md), with [errors.md](contracts/errors.md) and
[ui.md](contracts/ui.md).

## Technical Context

**Language/Version**: TypeScript 6 (`strict`) on Node.js 24; SQL for PostgreSQL 17

**Primary Dependencies**: slice 0–2 stack, plus `big.js@7.0.1` and `@types/big.js@7.0.0`
(contracts; R1), `@tanstack/react-virtual@3.14.23` (frontend; chosen in ADR-0018, first
installed now). Recorded in ADR-0020 and ADR-0010.

**Storage**: PostgreSQL 17. New tables `purchase_orders`, `order_lines`,
`po_number_counters`, `order_status_transitions`, `idempotency_keys` (migration
`0013_orders`).

**Testing**: Vitest + Supertest + Testcontainers PostgreSQL 17 (no DB mocks); the
integrity attack suite; property tests (`fast-check@4.10.2`, a new dev dependency, for
the constitution's property-based invariants suite) for money, line diffs and totals; plan tests with a fixed-seed dataset; Testing Library + vitest-axe + MSW;
Playwright + axe; the editor interaction benchmark.

**Target Platform**: the existing docker compose stack; nginx config change only.

**Project Type**: web application (API + SPA), npm workspaces.

**Performance Goals**: ADR-0012: create or replace a 500-line order p95 ≤ 500 ms; "My
orders" for the busiest buyer p95 ≤ 150 ms; editor keystroke ≤ 50 ms, add/remove ≤ 100 ms;
route chunk ≤ 150 KB gzip. Plans committed at 100k orders / ~1M lines / ~2M audit entries.

**Constraints**: no float for money anywhere; strict bodies with `READ_ONLY_FIELD`; deny
by default; derived values writable only by `recompute_orders`; 4 MiB body limit on order
writes only, nginx equal (R8).

**Scale/Scope**: 6 operations, 5 tables, 8 order indexes, 7 SQLSTATEs, 1 error code + 3
field codes, 3 audit events, 4 screens, 1 new dialog + 1 amended.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this slice complies | Status |
|---|---|---|
| I. Derived-value integrity | INV-1 generated; INV-2/INV-6 by statement triggers via a `SECURITY DEFINER` recompute; INV-4/INV-5 by `CHECK` and deferred constraint triggers; app role has no privilege on derived columns; privileged write → `PO005`; `READ_ONLY_FIELD` for derived fields in bodies; `big.js` strings end to end; reconciliation after every suite and seed | Pass |
| II. State machine | Created in `DRAFT`; status changes refused by a transition table that is empty until slice 4; delete only while `DRAFT`; lines change only while `DRAFT`; PO numbers unique, never reused, immutable | Pass |
| III. Authorization | `role` access before validation; owner/Admin/Approver scoping in SQL and under lock; 404 before 403; matrix cells tested, including the three cells approved and added to ADR-0004 on 2026-11-12 (R11) | Pass |
| IV. Audit | `PO_CREATED`, `PO_EDITED` (field-level line diff), `PO_DRAFT_DELETED` in the change's transaction; `require_actor_context` on both tables; entries outlive deleted drafts | Pass |
| V. Concurrency | Lock order → lines → vendor, counter last (ADR-0006 amended); `If-Match` on edit/delete; idempotent create in one transaction; barrier tests for edit/edit, edit/delete, 50 creates | Pass |
| VI. API contract | Zod first; `Money` brand; registry + messages; body inventory; additive OpenAPI diff | Pass |
| VII. Performance | Indexes per scope × filter; `LIMIT`ed SQL; one line-count query per page; recompute once per statement; committed page and `COUNT` plans at ADR-0012 sizes, the short PO prefix included (sorted by PO number, R7) | Pass |
| VIII. Test-first | Each story's tests first, seen failing against Testcontainers; integrity and property suites | Pass |
| IX. Operability and security | No new config or secret; CSRF on writes; larger body limit only on two Buyer routes, parsed only after authentication, CSRF and the role check, unread bodies refused with the connection closed (R8); idempotency purge under the maintenance role | Pass |
| X. Brief binding | §3.2, §3.3, §6 rows; owner decisions recorded as ADR updates; the three new matrix cells signed off before being written (R11) | Pass |
| XI. Code clarity | `orders/` area with routes → service → repository; constants once, SQL copies pinned | Pass |
| XII. Simplicity | No stored line count; no new error code beyond one; two dependencies, each with an ADR entry | Pass |
| XIII. Frontend | Generated client; ConfirmDialog for delete only; unsaved-changes guard; conflict reload; INR formatting; axe | Pass |

**Gate result (pre-research)**: PASS.

**Re-check after Phase 1 design**: PASS, no deviation. ADR updates made with this plan:
ADR-0001 (PO number allocation inside the create, at its end; gaps only from deleted
drafts; the queueing trade-off), ADR-0003 (one recompute per line statement; an edit runs
at most three), ADR-0006 (lock order adds the counter row last; no replay gap), ADR-0007
(order field rules, list filters, order-write body limit, new codes), ADR-0010 (`big.js`),
ADR-0020 (the two dependencies; nginx limits equal the API's). Spec updated: FR-002 and
the gap edge case (no gap on rollback), FR-021 (per-statement recompute count).
`docs/traceability.md` FR-PO-05 and NFR-PERF-03 test text updated. ADR-0004 gains the
three cells of R11 (owner sign-off, 2026-11-12); ADR-0007 also records the PO-number sort
and the order-write parsing order.

## Project Structure

### Documentation (this feature)

```text
specs/004-draft-orders/
├── spec.md, checklists/requirements.md
├── plan.md            # this file
├── research.md        # R1–R12
├── data-model.md      # migration 0013, triggers, reconciliation, audit events
├── quickstart.md
├── contracts/         # api.md, errors.md, ui.md
└── tasks.md           # /speckit-tasks
```

### Source Code (new and changed)

```text
packages/contracts/src/
├── money.ts                    # big.js wrapper (R1)
├── orders.ts                   # constants
├── schemas/orders.ts           # bodies, order, list item, list query
├── schemas/read-only.ts        # READ_ONLY_FIELD guard
├── errors.ts                   # + IDEMPOTENCY_KEY_REUSED, + 3 field codes
└── operations.ts               # + 6 operations, Idempotency-Key header, body limit per op
packages/contracts/tests/       # money (property), schemas, body inventory, OpenAPI money fields

backend/prisma/migrations/0013_orders/migration.sql
backend/prisma/schema.prisma    # models (derived columns read-only)
backend/src/
├── orders/
│   ├── routes.ts  service.ts  repository.ts
│   ├── line-diff.ts            # pure: added / changed / removed (R6)
│   └── po-number.ts            # allocation statement (R2)
├── idempotency/repository.ts   # R5
├── http/middleware/parse-json.ts   # per-operation limit; refusals close without draining (R8)
├── db/errors.ts                # PO005–PO011
├── db/reconciliation.sql       # + runner used by tests and seeds
├── audit/events.ts             # + 3 order events
├── maintenance/purge.ts        # + idempotency keys
└── migrate/seed-demo.ts        # + demo drafts
backend/tests/
├── integration/orders-*.test.ts, order-constants.test.ts, po-number.test.ts,
│   idempotency.test.ts, order-body-limit.test.ts, authorization-matrix (rows)
├── integrity/attack-suite.test.ts, trigger-count.test.ts, reconciliation.test.ts
├── concurrency/orders.test.ts
└── plans/orders-fixture.ts, orders.plan.test.ts,  # + scripts/plans-orders.ts, docs/query-plans/orders/
    orders.timing.test.ts                         # 500-line create/replace and busiest-buyer page p95
deploy/nginx/default.conf       # /api/orders 4m, /api/ 1m (R8)
.github/workflows/plans.yml     # + plans:orders drift check

frontend/src/
├── pages/orders/   # OrdersList, OrderDetail, OrderEditor (virtualised), OrderTimeline, DeleteDraftDialog, queries
├── pages/vendors/DeactivateVendorDialog.tsx   # + draft count
├── errors/messages.ts
└── app/router.tsx, Shell.tsx
frontend/e2e/orders.spec.ts
```

**Structure Decision**: one `orders/` backend area. The line diff is a pure module so it
gets property tests; the PO number allocation is its own module because slice 4's tests
and the load seed reuse it. Idempotency is its own area because slice 6's receipts reuse
it.

## Story order for `/speckit-tasks`

0. **Foundational**: migration 0013 part 1 (tables, grants, indexes, reconciliation); contracts
   (money, constants, schemas, read-only guard, codes, operations, inventory); per-route
   body limit and nginx; audit events; frontend routes and messages.
1. **US2 The total can never drift** (P1), first because every other story's tests
   assume it: trigger tests, integrity attack suite and trigger counts seen failing on
   part 1, then migration 0013 part 2 (the derived-value and rule triggers, same file),
   then PO number allocation.
2. **US1 Raise a draft** (P1): create with idempotency and PO numbers; editor (create).
3. **US3 Edit a draft** (P1): line diff, `If-Match`, `PO_EDITED`; editor (edit), guard,
   conflict reload.
4. **US6 Visibility and roles** (P1): matrix rows; read-only screens for Admin/Approver.
5. **US5 Find and read** (P1): list filters and indexes, detail, timeline; plans.
6. **US4 Delete a draft** (P2): delete, dialog, deleted-draft timeline (Admin only).
7. **Polish**: vendor dialog count, demo seed, e2e, load-target check, traceability rows,
   quickstart run.

Each story: tests first, seen failing against real PostgreSQL, then code.

## Phase notes for `/speckit-tasks`

- `LEFTHOOK_EXCLUDE=eslint` only for test-first commits importing code not yet written.
- Docs touched: `docs/traceability.md` statuses (FR-PO-01/02/03/04/05/06/07, FR-VEN-02
  create/edit part, FR-SM-02, NFR-DATA-01, NFR-PERF-03 line part, FR-RPT-03 line part,
  NFR-AUD-01 raise part, NFR-AUD-03 order part, NFR-FE-01/03/04/06/09 parts, FR-OWN-01, FR-ACT-01, NFR-AUTH-01/02
  draft cells, NFR-VAL-01, NFR-CON-01/03, NFR-PERF-01 order parts),
  `docs/query-plans/orders/`.

## Complexity Tracking

No deviations.
