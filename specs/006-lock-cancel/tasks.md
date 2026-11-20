---

description: "Task list for Slice 5 — Cancel approved orders, and the remaining locks"
---

# Tasks: Slice 5 — Cancel approved orders, and the remaining locks

**Input**: Design documents from `specs/006-lock-cancel/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Required (Principle VIII). Every test task is **run and seen failing against
real PostgreSQL** (Testcontainers) before the task that makes it pass; its commit body
carries a "Failing run:" line under 100 characters. Requirement IDs go in test names only
(ADR-0013). Never weaken, skip or delete a test to pass.

**Order rule** (as slices 3 and 4): migration `0015_cancel` part 1, the guard and the
raw-SQL attacks (Phase 3, US3) are done and green **before any cancel service, repository
or route code** (first in Phase 4, T018). The trigger and attack tests are seen failing
on part 1 (columns, checks, transition row) before part 2 (the guard, D1's branch).

**Operations per story**: Foundational adds constants, schemas and the role-detail map,
but no new operation. US1 adds `cancelOrder` to `OPERATIONS` with its route, and grows the
OpenAPI operation list, the body inventory, the route table and the authorization-matrix
pins in the same commit.

**Organization**: the carried-over timings first (Phase 1), Foundational, then US3 → US1 →
US2 → US4 → US5 (plan order), then Polish. Stories run in sequence; each ends with a
checkpoint (green CI on the slice's draft PR) and a short summary stop.

## Format: `- [ ] T### [P?] [US#?] Outcome — files — refs`

- **[P]**: parallel with the other [P] tasks of the same group (different files, no
  dependency on an incomplete task).
- **Refs**: spec FR/SC, research R#, ADR, and the `docs/traceability.md` row ID the tests
  carry.
- **Size**: one reviewable commit each, roughly under 300 changed lines.
- **Layering**: `routes.ts` → `service.ts` → `repository.ts`; routes never import Prisma,
  a repository or `db/transaction.ts`.
- **While working**: run only the affected tests; the full gate
  (`set -o pipefail; npm test 2>&1 | tail -40`) and `npm run e2e:local` before each push.
- `LEFTHOOK_EXCLUDE=eslint` only for test-first commits importing code not yet written.

---

## Phase 1: Setup and the carried-over timings

- [X] T001 Service timings: submit and approve take `WARM_UP_RUNS = 3` then 50 timed runs,
  through one shared `TIMED_RUNS = 50` replacing `WRITE_RUNS` and `LIST_RUNS`; targets unchanged (submit ≤ 500 ms, approve
  `DECISION_P95_MS` = 150 ms); `npm run test:plans` green; results in research R8 —
  `backend/tests/plans/orders.timing.test.ts` — FR-019, NFR-PERF-01.
- [X] T002 Commit the spec, plan, research, data model, contracts, quickstart, tasks and
  the ADR updates (0001, 0004, 0006, 0012, 0016, owner sign-offs 2026-11-20); draft PR for
  `006-lock-cancel` against `main`, body linking them; no dependency change — GitHub.

---

## Phase 2: Foundational (blocks every story)

### Schema: migration `0015_cancel`, part 1 (columns, checks, transition, index)

- [X] T003 Migration tests, seen failing: as [data-model.md](data-model.md), each rule by
  name:
  - `purchase_orders` gains `cancelled_by uuid` (FK `users (id)`), `cancelled_at
    timestamptz`, `cancel_reason text`; "`purchase_orders_cancel_matches_status`: all three
    set iff `status = 'CANCELLED'`"; "`purchase_orders_cancel_reason_valid`" with the
    `withdraw_reason` rule (trimmed, 1–500, line breaks allowed); `po_app` gains `UPDATE
    (cancelled_by, cancel_reason)` only (not `cancelled_at`, set by the guard)
  - `order_status_transitions` holds exactly T4, T5, T7, T8, T9 and `APPROVED → CANCELLED`
  - "`purchase_orders_cancelled_by_idx ON purchase_orders (cancelled_by) WHERE
    cancelled_by IS NOT NULL`"
  — `backend/tests/integration/migrations.test.ts`, `approval-schema.test.ts` —
  data-model.md, R1, R8, FR-SM-01.
- [X] T004 Migration `0015_cancel` part 1: columns, checks, grants, transition row,
  index; Prisma model (cancel columns read-only to the client) —
  `backend/prisma/migrations/0015_cancel/migration.sql`, `backend/prisma/schema.prisma` —
  R1, R8.
- [X] T005 [P] Constants pinned, seen failing first: `ORDER_TRANSITIONS` gains
  `['APPROVED', 'CANCELLED']` (= the SQL rows); `ORDER_ACTIONS` gains `CANCEL`; the
  reason limit pinned to `purchase_orders_cancel_reason_valid` —
  `packages/contracts/src/orders.ts`, `approvals.ts`,
  `backend/tests/integration/order-constants.test.ts` — R5.

### Contracts

- [X] T006 [P] Schemas, seen failing first: `order` gains `cancellation` (`{ cancelledBy:
  { id, name }, cancelledAt, reason } | null`); `ORDER_READ_ONLY_FIELDS` gains
  `cancellation`, `cancelledBy`, `cancelledAt`, `cancelReason` —
  `packages/contracts/src/schemas/orders.ts`, `packages/contracts/tests/order-schemas.test.ts`
  — contracts/api.md, R6.
- [X] T007 [P] Messages, seen failing first: `ORDER_LOCKED_MESSAGES.CANCELLED` "This order
  was cancelled and is closed."; `ORDER_CANCEL_APPROVER_ONLY_MESSAGE` "Only Approvers can
  cancel orders."; `ORDER_CANCEL_FORBIDDEN_DETAIL` (Admin, Buyer); `SELF_APPROVAL_DETAIL`
  becomes per action (`APPROVE`/`REJECT` keep "You can't approve or reject an order you
  raised.", `CANCEL` "You can't cancel an order you raised."); the two marker sentences
  as constants; approve's and reject's callers switched to the map in the same commit —
  `packages/contracts/src/orders.ts`, `approvals.ts`, `backend/src/approvals/service.ts`,
  `frontend/src/errors/messages.ts`, `packages/contracts/tests/errors.test.ts` —
  ADR-0004 2026-11-20, R5, R6.
- [X] T008 [P] Database errors `PO018` (`ORDER_CLOSED`), `PO019` (`ORDER_CANCEL_REFUSED`) →
  `INTERNAL_ERROR` with their names, unit test first — `backend/src/db/errors.ts`,
  `backend/tests/unit/db-errors.test.ts` — R2.
- [X] T009 [P] Audit event `PO_CANCELLED` with `details { round, reason, lines: [{ lineId,
  position, quantity, receivedQuantity }] }`; `ORDER_AUDIT_ACTIONS` extended; unit test
  first — `backend/src/audit/events.ts`, `packages/contracts/src/orders.ts`,
  `backend/tests/unit/audit-write.test.ts` — R7, ADR-0016 2026-11-20.
- [X] T010 [P] Web messages: `ORDER_LOCKED` with `CANCELLED`; `SELF_APPROVAL` by action;
  `FORBIDDEN` cancel details; `INVALID_STATE_TRANSITION` with action `CANCEL`;
  `isLockedStatus` covers `CANCELLED`; tests first — `frontend/src/errors/messages.ts`,
  `frontend/tests/error-messages.test.ts` — contracts/errors.md.

**Checkpoint**: migration part 1 applied; contracts build; gate green.

---

## Phase 3: User Story 3 — A cancelled order is locked and final (P1)

**Goal**: the database refuses every change to a rejected or cancelled order and any
cancel without its record. **Independent test**: the attacks below, each refused, then
reconciliation zero rows.

- [X] T011 [P] [US3] Trigger tests, seen failing on part 1: as `po_app` with an actor
  context, on a planted cancelled order: `version`, `cancel_reason`, `cancelled_at`,
  `vendor_id`, `status` → `PO018`; on a planted rejected order: `version`, `status`
  (reopen) → `PO018`; on an approved order: setting the cancel columns without the status
  → `PO019`; `APPROVED → CANCELLED` also changing `vendor_id`, `total`… or `version` by
  ≠ 1 → `PO019`; `cancelled_by` ≠ acting user, = owner, or actor `SYSTEM` → `PO016`;
  `CANCELLED` with no record → `23514`; the allowed cancel sets `cancelled_at` from the
  database clock — `backend/tests/integration/approval-triggers.test.ts` — D9–D11,
  FR-011, FR-LCK-01, FR-SM-01.
- [X] T012 [P] [US3] Attack suite, seen failing: the T011 attacks as `po_app` and as a
  privileged role (loud error, no silent fix); D1's cancelled branch: a cancelled order
  whose round is reopened, or whose `approved_at` moves → `PO014`; every attack ends in
  reconciliation zero rows. Update the slice 4 attack "reopen a rejected order": its
  expected SQLSTATE becomes `PO018` in both the `po_app` and owner-role runs (D9 fires
  before `PO009`; still refused, owner sign-off R10 Q4); the commit body names the
  `PO009 → PO018` change and why — `backend/tests/integrity/approval-attacks.test.ts`,
  `reconciliation.test.ts` — FR-011, SC-002.
- [X] T013 [US3] Migration part 2: `purchase_orders_cancel_guard()` (D9 for `REJECTED`
  and `CANCELLED`, D10, D11, `cancelled_at := now()`), `SECURITY INVOKER`, pinned
  `search_path`, `REVOKE … FROM PUBLIC`; `approval_inconsistency` replaced with the
  `CANCELLED` branch and no "not reachable" fallback; T011, T012 green —
  `backend/prisma/migrations/0015_cancel/migration.sql` — R2, data-model.md.
- [X] T014 [P] [US3] Trigger efficiency: the guard fires once per row and adds no query
  to an order edit; the existing trigger-count test extended —
  `backend/tests/integrity/trigger-count.test.ts` — Principle VII.
- [X] T015 [US3] Lock codes, tests first: owner's edit and delete of a cancelled order →
  `409 ORDER_LOCKED` "This order was cancelled and is closed." with `orderState.status`;
  submit, withdraw, approve, reject of a cancelled order → `409 INVALID_STATE_TRANSITION`
  with status and action (after role, visibility, ownership) —
  `backend/tests/integration/orders-lock.test.ts`, `backend/src/orders/service.ts` —
  FR-010, FR-LCK-01.
- [X] T016 [P] [US3] Editor: saving an order cancelled meanwhile shows the cancelled
  message, component test first — `frontend/tests/order-editor-edit.test.tsx`,
  `frontend/src/pages/orders/` — US3 scenario 5, NFR-FE-09.
- [X] T017 [US3] State machine: T10 allowed from `APPROVED`; refused from `DRAFT`,
  `PENDING_APPROVAL`, `REJECTED`, `CANCELLED` (database and service), one test each —
  `backend/tests/integration/order-triggers.test.ts` — FR-009, FR-012, FR-SM-01.

**Checkpoint**: no path, API or raw SQL, changes a rejected or cancelled order.

---

## Phase 4: User Story 1 — Cancel an approved order (P1) 🎯 MVP

**Goal**: an Approver cancels an approved order they don't own, with a reason.
**Independent test**: spec US1's independent test.

- [X] T018 [US1] Cancel service tests, seen failing: approved (step) and auto-approved
  orders cancelled with a reason and version → `CANCELLED`, version +1, `cancellation`
  set; one `PO_CANCELLED` (actor `USER`, acting `APPROVER`, round, reason, each line's
  quantity and 0 received, position order); vendor inactive → succeeds; owner deactivated
  or without BUYER → succeeds; reason missing `REQUIRED`, `""`/`"   "` `TOO_SHORT`, 501
  `TOO_LONG`, extra field `UNKNOWN_FIELD`; an order id that doesn't exist `404`, an
  invalid id `400`; no `If-Match` `VERSION_REQUIRED`; stale
  `VERSION_CONFLICT`; nothing changes on any refusal —
  `backend/tests/integration/approvals-cancel.test.ts` (new) — FR-001–FR-005, FR-016,
  FR-LCK-02, FR-VEN-02, FR-ACT-01, NFR-CON-03.
- [X] T019 [US1] Cancel repository and service: lock order `FOR UPDATE` → the acting
  Approver's `users` row `FOR SHARE` (`lockUsers`); checks: Approver re-check → 404 →
  `SELF_APPROVAL` (cancel detail) → `INVALID_STATE_TRANSITION` (`CANCEL`) →
  `VERSION_CONFLICT`; one `UPDATE` (status, version +1, `cancelled_by`, `cancel_reason`);
  lines read under the order lock for the audit; audit in the transaction —
  `backend/src/approvals/service.ts`, `repository.ts` — R3, R7, ADR-0006 2026-11-20.
- [X] T020 [US1] Route and operation: `cancelOrder` (`POST /orders/:id/cancel`, role
  APPROVER, `ORDER_CANCEL_FORBIDDEN_DETAIL`, `If-Match` required, `decisionReasonBody`,
  `200` order with `ETag`); OpenAPI regenerated (additive); route table, CSRF, body
  inventory, matrix pins — `packages/contracts/src/operations.ts`,
  `backend/src/approvals/routes.ts`, `backend/tests/integration/route-table.test.ts`,
  `packages/contracts/tests/openapi.test.ts`, `body-inventory.test.ts` — contracts/api.md;
  T018 green.
- [X] T021 [US1] Order read gains `cancellation` (canceller's current name, time, reason)
  for everyone who can read it; tests first — `backend/src/orders/repository.ts`,
  `backend/tests/integration/orders-read.test.ts` — FR-003, R6, ADR-0004 2026-11-20.
- [X] T022 [P] [US1] Cancel dialog, component tests first: names PO number, buyer,
  vendor, total; "Nothing has been received against this order."; the final-and-no-receipts
  sentence; reason required ("Enter a reason." for empty or whitespace), 500 limit, server
  field errors at the field; focus starts on "Keep order"; Reload order on
  `VERSION_CONFLICT`, `INVALID_STATE_TRANSITION`, `NOT_FOUND` (added to
  `order-dialog-reload.test.tsx`'s list); `SELF_APPROVAL`, `FORBIDDEN`,
  `ACCOUNT_DEACTIVATED` by code; axe — `frontend/src/pages/orders/CancelDialog.tsx`,
  `frontend/tests/cancel-order-dialog.test.tsx` (new), `order-dialog-reload.test.tsx` —
  FR-017, contracts/ui.md, NFR-FE-09.
- [X] T023 [US1] Order detail, tests first: Cancel order button only for an Approver who
  isn't the owner on `APPROVED`; Cancellation section ("Cancelled by {name} on {date}",
  reason) and no actions on a cancelled order; the owner-can't-act marker on an approved
  order (first sentence for every reader, the second only for an Approver who may
  cancel); axe — `frontend/src/pages/orders/OrderDetail.tsx`, `CancellationSection.tsx`,
  `frontend/tests/order-approval-detail.test.tsx`, `order-cancel-detail.test.tsx` (new) —
  FR-017a, FR-018, NFR-FE-08.

**Checkpoint**: an Approver cancels from the page; the owner reads who, when and why.

---

## Phase 5: User Story 2 — Only the right people cancel, only approved orders (P1)

- [X] T024 [US2] Matrix cancel row, tests first where new: owner Buyer and other Buyer →
  `403 FORBIDDEN` "Only Approvers can cancel orders." before validation (a bad body still
  403); owner Buyer+Approver → `403 SELF_APPROVAL` "You can't cancel an order you
  raised."; other Buyer+Approver and Approver → `404` on a draft, `409` on pending,
  rejected, cancelled, `200` on approved; Admin → `403` with the Admin detail; no role
  `403 NO_ROLE_ASSIGNED`; anonymous `401`; × 5 states; every refusal leaves the order and
  the audit unchanged — `backend/tests/integration/authorization-matrix.test.ts`,
  `approvals-sod.test.ts` — FR-006, FR-007, FR-SOD-01, FR-OWN-01, SC-001.
- [X] T025 [US2] Approver lost the right between read and confirm: deactivated →
  `401 ACCOUNT_DEACTIVATED`; APPROVER removed → `403 FORBIDDEN`; nothing changes —
  `backend/tests/integration/approvals-cancel.test.ts` — FR-008.

- [X] T026 [US2] `/security-review` of US2 (CLAUDE.md: permission stories; as slice 4's
  T049): the cancel route's role check, the under-lock Approver re-check, `SELF_APPROVAL`
  in the service and in the database (D11); fix findings tests first. The slice-end
  review (T036) stays.

---

## Phase 6: User Story 4 — Cancelled orders visible to the right people (P2)

- [X] T027 [US4] Read, timeline and list rows for `CANCELLED`: owner, Approver, Admin
  read it and its timeline; other Buyer `404`; no role `403`; list filtered to Cancelled
  returns only readable cancelled orders per scope; never in the queue or its count —
  `backend/tests/integration/authorization-matrix.test.ts`, `orders-list.test.ts`,
  `approvals-queue.test.ts` — FR-013, FR-014, FR-OWN-01.
- [X] T028 [P] [US4] Plan fixture: 1,000 of the 90,000 approved orders `CANCELLED` with
  their record (ADR-0012 2026-11-20); plan cases `status=CANCELLED` and
  `status=CANCELLED + vendor` for all four scopes (pages and counts by the slice 4 rule);
  plans committed; **no new index unless a case fails** — if one does, stop and show the
  owner — `backend/tests/plans/orders-fixture.ts`, `orders.plan.test.ts`,
  `docs/query-plans/orders/` — R8, NFR-PERF-01.
- [X] T029 [P] [US4] Web: the list's status filter offers Cancelled (pinned); a cancelled
  row shows its status — `frontend/tests/orders-list.test.tsx` — FR-018.

---

## Phase 7: User Story 5 — Concurrent cancels end in one outcome (P2)

- [X] T030 [US5] Races, barriers, 10 runs each, business outcomes asserted (research R4):
  cancel vs cancel; cancel vs the Approver's deactivation and vs APPROVER removal, each
  started in either order; cancel vs vendor deactivation; cancel vs owner deactivation or
  BUYER removal; cancel vs the owner's edit or delete; no deadlock; one `PO_CANCELLED` at
  most — `backend/tests/concurrency/cancel.test.ts` (new), `lock-order.test.ts` —
  FR-015, NFR-CON-01, SC-003.

---

## Phase 8: Polish & cross-cutting

- [X] T031 [P] Cancel timing: p95 ≤ `DECISION_P95_MS` (150 ms), 50 timed runs after 3
  warm-up, on the plan fixture — `backend/tests/plans/orders.timing.test.ts` — SC-006.
- [X] T032 [P] Demo seed: one cancelled order per demo Buyer through the cancel service,
  by the Demo Approver; idempotent on reseed; reconciliation zero rows —
  `backend/src/migrate/seed-demo.ts`, `backend/tests/integration/seed-demo.test.ts` —
  spec Assumptions.
- [X] T033 E2E: Approver cancels an approved order (dialog, reason, success, Cancellation
  section); the owner sees it cancelled and the editor refuses with the cancelled
  message; Buyer+Approver gets no Cancel on their own order; axe on the dialog and page —
  `frontend/e2e/cancel.spec.ts` (new) — NFR-FE-07, NFR-FE-09, SC-004, SC-005. Run
  `npm run e2e:local`.
- [ ] T034 Traceability: FR-LCK-01 (both rows) and FR-SOD-01 → Done; FR-LCK-02 → Tested
  (the fully-received refusal arrives in slice 6), FR-OWN-01 → Tested (the dual-role
  receipt cell, slice 6), FR-SM-01 → Tested (receipt-driven checks, slice 6), each note
  naming slice 6;
  NFR-CON-01, NFR-CON-03, NFR-FE-08, NFR-FE-09, NFR-PERF-01 parts — each with its passing
  test; `npm run check:traceability` green — `docs/traceability.md`.
- [ ] T035 Quickstart run and results — `specs/006-lock-cancel/quickstart-results.md`.
- [ ] T036 Slice-end review: `/code-review`, `/security-review` (permissions, the new
  guard, separation of duties), constitution pass; fix findings; full gate, lint,
  typecheck green.

---

## Owner requirements → tasks

| Requirement (2026-11-20) | Tasks |
|---|---|
| Timings at 50 timed runs after 3 warm-up, first | T001 |
| Cancel record as three columns, CHECK, immutable once set | T003, T004, T011, T013 |
| No filter index unless a plan fails | T028 |
| DB lock covers lines, round, steps, vendor snapshot, cancel columns | T011, T012, T013 |
| D9 covers `REJECTED` too | T011, T012, T013 |
| Lock order, Approver re-checked under lock | T019, T025, T030 |
| Pure Buyer `403 FORBIDDEN`; `SELF_APPROVAL` cancel detail | T007, T024 |
| Owner-can't-act marker on approved orders | T007, T023 |
| Canceller's name readable | T021, T023 |
| 1,000 cancelled in the dataset; `cancelled_by` index | T004, T028 |

## Dependencies and execution order

- T001 first; T002 → Foundational (T003–T010) → US3 (T011–T017) → US1 (T018–T023) → US2
  (T024–T026) → US4 (T027–T029) → US5 (T030) → Polish (T031–T036).
- Foundational: T003 → T004; T005–T010 in parallel after T004.
- US3: T011, T012 seen failing on part 1 → T013; T014, T016 in parallel; T015, T017 after
  T013.
- US1: T018 → T019 → T020 → T021; T022 in parallel with T019–T021; T023 after T021.
- T031, T032 in parallel; T033 → T034 → T035 → T036.

## Parallel examples

- Foundational: T005, T006, T007, T008, T009, T010 together.
- US3: T011, T012 together; then T013.
- US4: T028, T029 together.
- Polish: T031, T032 together.

## Implementation strategy

Timings first (T001), then the database rules (US3): before any cancel code, no path can
change a rejected or cancelled order or produce a cancel without its record. MVP is US1
(cancel from the page). US2 proves the matrix row, US4 visibility and the filter plans,
US5 the races. Each story: tests first, seen failing against real PostgreSQL, then code;
a short summary stop after each story.
