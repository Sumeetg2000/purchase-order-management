---

description: "Task list for Slice 4 — Submission, routing, approval, rejection and withdrawal"
---

# Tasks: Slice 4 — Submission, routing, approval, rejection and withdrawal

**Input**: Design documents from `specs/005-submit-approve/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Required (Principle VIII). Every test task is **run and seen failing against
real PostgreSQL** (Testcontainers) before the task that makes it pass; its commit body
carries a "Failing run:" line under 100 characters. Requirement IDs go in test names only
(ADR-0013). Never weaken, skip or delete a test to pass.

**Order rule** (as slice 3): migration `0014_approvals`, every trigger and the raw-SQL
approval attacks (Phase 2 and Phase 3, US2) are done and green **before any approvals
service, repository or route code** (first in Phase 4, T022). The trigger and attack
tests are seen failing on the migration's tables (part 1) before the triggers (part 2)
are written.

**Operations per story**: Foundational adds constants, schemas, codes and the
role-detail map, but no new operation. Each story adds its operations to `OPERATIONS`
with routes, and grows the OpenAPI operation list, the body inventory and the
authorization-matrix pins in the same commit: US1 `submitOrder`, `getApprovalPolicy`;
US3 `approveOrder`, `listApprovalQueue`; US4 `rejectOrder`; US5 `withdrawOrder`.

**Organization**: Setup, Foundational, then US2 → US1 → US3 → US4 → US5 → US6 → US8 → US7
(plan order; US7's CLI last because the seed policy serves every earlier story), then
Polish. Stories run in sequence; each ends with a checkpoint (green CI on the slice's
draft PR) and a short summary stop.

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

## Phase 1: Setup

- [X] T001 Draft PR for `005-submit-approve` against `main`, body linking the spec, plan
  and the owner sign-offs of 2026-11-17 (constitution 3.0.2; ADR-0001, 0002, 0004, 0006,
  0007, 0012, 0016, 0019 amendments); no dependency changes (plan: none) — GitHub.

---

## Phase 2: Foundational (blocks every story)

### Schema: migration `0014_approvals`, part 1 (tables, grants, indexes, seed)

- [X] T002 Migration tests, seen failing: tables and columns exactly as
  [data-model.md](data-model.md), each rule by name:
  - `approval_policies (version integer PK ≥ 1, effective_at, created_at)`,
    `approval_policy_tiers (policy_version, tier smallint ≥ 1, threshold numeric(22,4) > 0,
    PK (policy_version, tier))`; `po_app` `SELECT` only; seed version 1 with exactly one tier
    `100000.0000` and no audit entry (migration data, research R1)
  - `approval_rounds`: PK `(order_id, round)`, FK to `purchase_orders ON DELETE CASCADE`;
    `vendor_snapshot` "object with `id`, `name`, `contactName`, `contactEmail`,
    `contactPhone`, `paymentTerms`"; `outcome IN ('AUTO_APPROVED','APPROVED','REJECTED',
    'WITHDRAWN')` or null; "`CHECK ((outcome IS NULL) = (closed_at IS NULL))`";
    "`CHECK ((outcome = 'WITHDRAWN') = (withdraw_reason IS NOT NULL))`"; grants `SELECT`,
    `INSERT (order_id, round, policy_version, total, vendor_snapshot, submitted_by)`,
    `UPDATE (outcome, closed_at, withdraw_reason)`
  - `approval_steps`: PK `(order_id, round, step)`, FK to its round `ON DELETE CASCADE`;
    `state IN ('OPEN','APPROVED','REJECTED','VOIDED')`; the per-state shape `CHECK`
    (OPEN: no decision, no void; APPROVED: decision, no reason, no void; REJECTED: decision
    and reason, no void; VOIDED: `voided_at`, no reason); grants `SELECT`, `INSERT
    (order_id, round, step, tier, threshold)`, `UPDATE (state, decided_by, decided_at,
    decided_version, reason, voided_at)`
  - `purchase_orders` gains `current_round smallint`, `submitted_at`, `approved_at`;
    "`CHECK ((status = 'DRAFT') = (submitted_at IS NULL))`"; "`CHECK ((status IN
    ('APPROVED','CANCELLED')) = (approved_at IS NOT NULL))`"; `po_app` gains `UPDATE
    (status, current_round, submitted_at, approved_at)` and still nothing on `total`,
    `open_line_count`, `owner_id`, timestamps
  - `order_status_transitions` holds exactly T4, T5, T7, T8, T9
  - the six indexes of data-model.md, by name and predicate
  — `backend/tests/integration/migrations.test.ts`, `approval-schema.test.ts` (new) —
  data-model.md, R1, R2, R4, R7, FR-SM-01.
- [X] T003 Migration `0014_approvals` part 1: the tables, columns, checks, grants, indexes,
  transition rows, and the policy seed (no audit entry, research R1);
  Prisma models (derived and submission columns read-only to the client) —
  `backend/prisma/migrations/0014_approvals/migration.sql`, `backend/prisma/schema.prisma`
  — R1–R4, R7.
- [X] T004 [P] Constants pinned to their SQL copies, seen failing first:
  `APPROVAL_POLICY_SEED_TIERS`, `APPROVAL_ROUND_OUTCOMES`, `APPROVAL_STEP_STATES`,
  `ORDER_TRANSITIONS`, `DECISION_REASON_MAX = 500` (= the `withdraw_reason`/`reason`
  checks) — `packages/contracts/src/approvals.ts`,
  `backend/tests/integration/order-constants.test.ts` — R1, R2, R4.

### Contracts

- [X] T005 [P] Schemas, seen failing in schema tests first: `decisionReasonBody` (reason
  required, slice 3's plain-text rules, ≤ 500, line breaks allowed, other control
  characters `INVALID_FORMAT`), `emptyBody` (none or `{}`), `approvalStep`,
  `approvalRound`, `vendorOrderSnapshot`, `approvalQueueQuery`, `approvalQueueItem`,
  `approvalPolicy`; `order` gains `submittedAt`, `approvedAt`, `ownerCanAct`,
  `vendorSnapshot`, `approval`; `ORDER_READ_ONLY_FIELDS` gains those five keys —
  `packages/contracts/src/schemas/approvals.ts`, `schemas/orders.ts`,
  `packages/contracts/tests/` — contracts/api.md.
- [X] T006 [P] Registry, seen failing in the registry test: `ORDER_PENDING_APPROVAL` 409,
  `ORDER_OWNER_INACTIVE` 409, `ORDER_LOCKED` 409, `NOT_ORDER_OWNER` 403, `SELF_APPROVAL` 403
  with the detail texts of contracts/errors.md; `ORDER_LOCKED_MESSAGES` keyed by status;
  `DUPLICATE_APPROVER` absent — `packages/contracts/src/errors.ts`, `approvals.ts`,
  `packages/contracts/tests/errors.test.ts` — R8, FR-SOD-01.
- [X] T007 Role details: `OperationContract.adminForbiddenDetail` → `forbiddenDetail`
  (role set → detail); constants `ORDER_APPROVER_READ_ONLY_MESSAGE` ("Approvers can review
  orders but not change them.") and `ORDER_DECISION_APPROVER_ONLY_MESSAGE` ("Only
  Approvers can approve or reject orders."); slice 3's create, edit, delete moved to the
  map (Admin unchanged), edit and delete gain the pure-Approver detail; route-level
  `FORBIDDEN` writes the detail; tests first: a pure Approver's edit and delete → 403
  with the Approver text, an Admin's unchanged — `packages/contracts/src/operations.ts`,
  `orders.ts`, `backend/src/http/` (route access), `backend/tests/integration/orders-access.test.ts`
  — ADR-0004 2026-11-17, R9 S2, S4.
- [X] T008 [P] Database errors `PO012`–`PO017` → `INTERNAL_ERROR` with their names, unit
  test first — `backend/src/db/errors.ts`, `backend/tests/unit/db-errors.test.ts` — R8.

### Platform: actor switch, audit events, web plumbing

- [X] T009 `asSystem(tx, fn)`: test first (inside one transaction a USER entry, a SYSTEM
  entry with no user fields, then a USER entry again; the context is restored when `fn`
  throws; unusable outside `withTransaction`) — `backend/src/db/transaction.ts`,
  `backend/tests/integration/transaction.test.ts` — R5.
- [X] T010 [P] Audit events `PO_SUBMITTED`, `PO_AUTO_APPROVED`, `APPROVAL_STEP_APPROVED`,
  `APPROVAL_STEP_REJECTED`, `PO_WITHDRAWN` with the payload types of data-model.md (round
  in each; vendor snapshot in `PO_SUBMITTED`); `ORDER_AUDIT_ACTIONS` extended; unit test
  first — `backend/src/audit/events.ts`, `packages/contracts/src/orders.ts`,
  `backend/tests/unit/audit-write.test.ts` — ADR-0016 2026-11-17.
- [X] T011 [P] Web messages for the five codes and the two role details; `ORDER_LOCKED`
  picks its sentence from `orderState.status`; component tests first —
  `frontend/src/errors/messages.ts`, `frontend/tests/error-messages.test.ts` — R11,
  contracts/ui.md.

**Checkpoint**: migration part 1, contracts and plumbing green; no approvals code yet.

---

## Phase 3: User Story 2 — Submitted orders are locked (P1) 🎯 first

**Goal**: the database alone refuses every illegal status, step, round and submitted-order
change; the API answers edits of submitted orders with their specific codes.

**Independent test**: for pending, approved and rejected orders (built by raw SQL as the
superuser in the test, then checked), every edit path is refused with its specific
outcome, and reconciliation returns zero rows.

- [X] T012 [P] [US2] Trigger tests on part 1, seen failing, one per rule D1–D8 of R2, as
  `po_app` and as a privileged role: `APPROVED` with an open step (`PO014` at commit);
  a chain that skips or adds a tier, or whose round total differs from the order's
  (`PO014`); a decision on step 2 while step 1 is open, on a closed round, on a draft
  (`PO012`); `decided_by` = owner or ≠ acting user (`PO016`); `AUTO_APPROVED` under a USER
  context (`PO013`); any update after the round closed, any delete of a step or round of an
  existing order (`PO012`, `PO013`); `vendor_id`, `current_round`, `submitted_at`,
  `approved_at` changed outside a transition (`PO015`); each non-listed status change
  (`PO009`); the allowed moves succeed — `backend/tests/integration/approval-triggers.test.ts`
  — R2, R4, FR-006, FR-007, FR-SM-01, FR-LCK-01.
- [X] T013 [P] [US2] Raw-SQL approval attacks join the integrity suite, seen failing:
  every attack above plus a hand-built `DRAFT → APPROVED` above the threshold with no
  round; each refused with its SQLSTATE; reconciliation (with the new approval branch)
  zero rows after — `backend/tests/integrity/approval-attacks.test.ts` — FR-LCK-01,
  SC-003.
- [X] T014 [P] [US2] Reconciliation gains the approval-consistency branch (orders for
  which `order_approval_consistent` would fail), test first with a privileged inconsistent
  row — `backend/src/db/reconciliation.sql`, `backend/tests/integrity/reconciliation.test.ts`
  — data-model.md.
- [X] T015 [US2] Migration `0014_approvals` part 2: `set_approval_policy`,
  `approval_policy_immutable`, `approval_rounds_guard`, `approval_steps_guard`,
  `purchase_orders_submission_lock`, `order_approval_consistent` (deferred constraint
  triggers on the three tables), all `SET search_path = pg_catalog, pg_temp`, `REVOKE ALL
  FROM PUBLIC`; T012–T014 green — same migration file — R1, R2, R4.
- [X] T016 [US2] Order service lock codes, tests first: edit and delete of a
  `PENDING_APPROVAL` order → `409 ORDER_PENDING_APPROVAL` (status in `orderState`); of an
  `APPROVED` or `REJECTED` order → `409 ORDER_LOCKED` with the status's detail; a
  Buyer+Approver on another buyer's non-draft order → `403 NOT_ORDER_OWNER`; slice 3's
  placeholders removed — `backend/src/orders/service.ts`,
  `backend/tests/integration/orders-lock.test.ts` (new) — FR-007, FR-008, US2 scenarios
  1–3, FR-LCK-01.

**Checkpoint**: every database rule and lock code green; reconciliation zero rows.

---

## Phase 4: User Story 1 — Submit and routing (P1) 🎯 MVP

**Goal**: the owner submits; routing in SQL; auto-approval as `SYSTEM`; vendor snapshot.

**Independent test**: ₹1,00,000.00 → `APPROVED` with `PO_SUBMITTED` + `PO_AUTO_APPROVED`
(`SYSTEM`); ₹1,00,000.01 → `PENDING_APPROVAL` with one open step; both show the snapshot.

- [X] T017 [P] [US1] Routing tests, seen failing: seed boundaries `100000.0000` → auto,
  `100000.0001` and `100000.0100` → one step; two-tier fixture → two steps; three-tier
  chain by inserting policy rows only; the round records the highest policy version;
  a policy version inserted after submit leaves the chain unchanged —
  `backend/tests/integration/approvals-routing.test.ts` — FR-001, FR-002, FR-005,
  FR-APR-01, FR-APR-03, SC-002.
- [X] T018 [P] [US1] Submit API tests, seen failing: `If-Match` missing → 400
  `VERSION_REQUIRED`, stale → 409; any body field → 400 `UNKNOWN_FIELD`; inactive vendor →
  409 `VENDOR_INACTIVE`; second submit → 409 `INVALID_STATE_TRANSITION` with status and
  action; another Buyer → 404; Buyer+Approver non-owner on a pending order → 403
  `NOT_ORDER_OWNER`; Admin → 403 Admin detail; pure Approver → 403 Approver detail; the
  response has `submittedAt`, `vendorSnapshot`, `approval`, `version + 1`; vendor edited
  after submit leaves the snapshot — `backend/tests/integration/approvals-submit.test.ts`
  — US1 scenarios 1–6, FR-004, FR-VEN-03.
- [X] T019 [P] [US1] Submit races, seen failing (barriers, business outcomes): edit vs
  submit on one draft (one wins; the final status is the routing of the final total);
  submit vs vendor deactivation (submitted before, or 409 `VENDOR_INACTIVE` after);
  submit vs `set_approval_policy` (the round records the version its statement read, and
  its chain matches it) — `backend/tests/concurrency/approvals.test.ts` (new) — R6 races
  3, 6, 7, FR-017, SC-005, NFR-CON-01.
- [X] T020 [P] [US1] Audit tests, seen failing: `PO_SUBMITTED` (owner, `BUYER`, round,
  total, tiers, policy version, resulting status, snapshot) and `PO_AUTO_APPROVED`
  (`SYSTEM`, no user fields, threshold, version, round) in the submit transaction; a refused
  submit writes none — `backend/tests/integration/approvals-audit.test.ts` — FR-003,
  FR-020, NFR-AUD-01.
- [X] T021 [P] [US1] `getApprovalPolicy` tests, seen failing: Buyer, Approver, Admin get
  version 1 and its tier; no role → 403 `NO_ROLE_ASSIGNED`; the route table has no write
  to the policy — `backend/tests/integration/approval-policy.test.ts`,
  `route-table.test.ts` — FR-016, FR-APR-04.
- [X] T022 [US1] Approvals repository: lock order (shared helper from
  `orders/repository.ts`), insert round with snapshot and the highest policy version,
  insert steps by `threshold < total` from the round's own row (one `INSERT … SELECT`),
  status update; policy read — `backend/src/approvals/repository.ts` — R3, R4, R6.
- [X] T023 [US1] Approvals service `submitOrder`: lock order → vendor `FOR SHARE`; checks
  in R8's order; `PO_SUBMITTED`; if no step, `asSystem` → round `AUTO_APPROVED`, order
  `APPROVED` with `approved_at`, `PO_AUTO_APPROVED`; `getApprovalPolicy` — 
  `backend/src/approvals/service.ts` — R3, R5, R6.
- [X] T024 [US1] Routes and operations `submitOrder` (`POST /orders/:id/submit`, BUYER,
  `ifMatch`, role details) and `getApprovalPolicy` (`GET /approval-policy`), OpenAPI
  regenerated, body inventory, matrix pins; T017–T021 green —
  `backend/src/approvals/routes.ts`, `packages/contracts/src/operations.ts`,
  `packages/contracts/openapi/openapi.json` (generated) — contracts/api.md.
- [X] T025 [US1] Order reads: `getOrder` returns `submittedAt`, `approvedAt`,
  `ownerCanAct`, `vendorSnapshot` (non-draft), `approval` (current round with steps,
  deciders by id and name, reasons) in one statement; list items use the snapshot name for
  non-draft orders; tests first — `backend/src/orders/repository.ts`,
  `backend/tests/integration/orders-read.test.ts`, `orders-list.test.ts` — R10, FR-004.
- [X] T026 [US1] Web: Submit action and `SubmitDialog` (saved total; expected outcome
  from `GET /approval-policy`; "You can't edit it after submitting; you can withdraw it
  while it's pending"; actual outcome after), read-only detail for non-draft orders with
  snapshot vendor and approval panel, no Edit/Delete/Submit; component tests first —
  `frontend/src/pages/orders/OrderDetail.tsx`, `SubmitDialog.tsx`, `ApprovalPanel.tsx`,
  `frontend/tests/` — US1 scenario 7, US2 scenario 5, NFR-FE-09.

**Checkpoint**: submit end to end; MVP.

---

## Phase 5: User Story 3 — Approve and the queue (P1)

**Goal**: Approvers approve the current step from a queue that never holds their own
orders; the owner and the Approver are re-checked under lock.

**Independent test**: a ₹2,00,000 order appears in the Approver's queue; approve →
`APPROVED`, `APPROVAL_STEP_APPROVED`, gone from the queue and the count.

- [X] T027 [P] [US3] Approve API tests, seen failing: one step → `APPROVED` (T7) with
  `approved_at`; two-tier fixture: step 1 → still pending (T6), step 2 → `APPROVED`;
  `decided_version` = `If-Match`; inactive vendor → 409 `VENDOR_INACTIVE`; owner deactivated
  or without BUYER → 409 `ORDER_OWNER_INACTIVE` with its detail, reject still allowed, and
  approved again after access restored; stale → 409; missing `If-Match` → 400; not pending
  → 409 `INVALID_STATE_TRANSITION`; draft → 404; pure Buyer → 403 Buyer detail; Admin →
  403 Admin detail; the acting Approver deactivated or stripped of APPROVER between the
  request check and the lock (simulated with a barrier) → `401 ACCOUNT_DEACTIVATED` /
  `403 FORBIDDEN`; the owner, holding BUYER and APPROVER, → 403 `SELF_APPROVAL` after
  `404` and before every `409`, with no step or audit change —
  `backend/tests/integration/approvals-approve.test.ts` — US3 scenarios 1–5, US6
  scenario 1, FR-010, FR-013, FR-SM-01, FR-SOD-01.
- [X] T028 [P] [US3] Approve races and lock order, seen failing: double approve on one
  step (one decision); approve vs owner deactivation and vs owner BUYER removal (approved
  before, or 409 `ORDER_OWNER_INACTIVE` after, never after); approve vs the acting
  Approver's own deactivation and APPROVER removal (decided before, or `401
  ACCOUNT_DEACTIVATED` / `403 FORBIDDEN` after, never after); approve vs vendor
  deactivation; deadlock tests: an approve holding both `users` rows and an admin
  deactivation or role change of the owner, and of the Approver, in both start orders;
  lock-order rule: an approve waiting on a `users` row already holds the order, its steps
  and the vendor (`pg_locks` at a barrier); user-management code references no order
  table at all (a source check: held row locks don't show in `pg_locks`) — `backend/tests/concurrency/approvals.test.ts`,
  `backend/tests/concurrency/lock-order.test.ts` (new) — R6 races 4, 5, 5a, 6, ADR-0006,
  FR-017, SC-005.
- [X] T029 [P] [US3] Queue tests, seen failing: only `PENDING_APPROVAL`, never the
  caller's own (a Buyer+Approver's own pending order absent); oldest `submittedAt` first,
  then id; vendor filter; PO prefix sorts by PO number desc; `ownerCanAct` false for a
  deactivated owner; `total` = the nav count with `pageSize=1`; Buyer and Admin → 403
  `FORBIDDEN`; no role → `NO_ROLE_ASSIGNED` — `backend/tests/integration/approvals-queue.test.ts`
  — FR-014, S1, US3 scenario 6.
- [X] T030 [P] [US3] Approve audit test, seen failing: one `APPROVAL_STEP_APPROVED` (round,
  step, tier, version approved), `actingRole` `APPROVER` also for a dual-role user; none on
  refusal — `backend/tests/integration/approvals-audit.test.ts` — FR-020, US3 scenario 8.
- [X] T031 [US3] Repository: lock current round's steps (step asc) `FOR UPDATE`; lock the
  owner's and the Approver's `users` rows `FOR SHARE` in id order, returning status and
  roles; decide the lowest open step; queue page and count (deferred join, literal bounds,
  one statement, partial indexes, `owner_id <> $caller`) with snapshot name, current step,
  `ownerCanAct` — `backend/src/approvals/repository.ts` — R6, R7.
- [X] T032 [US3] Service `approveOrder`: locks in R6's order, then checks in R8's order
  (Approver re-check → 404 → `SELF_APPROVAL` → state → version → vendor → owner can act);
  T6 or T7; `listApprovalQueue` — `backend/src/approvals/service.ts` — R6, R8, FR-010,
  FR-013.
- [X] T033 [US3] Routes and operations `approveOrder` (`POST /orders/:id/approve`,
  APPROVER, `ifMatch`, role details) and `listApprovalQueue` (`GET /approvals`); OpenAPI,
  inventory, matrix pins; T027–T030 green — `backend/src/approvals/routes.ts`,
  `packages/contracts/src/operations.ts` — contracts/api.md.
- [X] T034 [US3] Web: `/approvals` queue screen (columns, filters in the URL, page
  numbers, empty state, marker), `ApproveDialog` (PO number, buyer, vendor, total; "The
  buyer can then receive goods; the order can't be edited"), marker "Owner can no longer
  act on this order" replacing Approve with Reject on detail and dialog, nav "Approvals"
  count (60 s, focus, after each action); component tests first —
  `frontend/src/pages/approvals/`, `frontend/src/app/Shell.tsx`, `router.tsx` — US3
  scenario 7, FR-023, NFR-FE-08.
- [X] T035 [US3] Plan fixture status mix (5,000 `DRAFT`, 3,000 `PENDING_APPROVAL`, 2,000
  `REJECTED`, 90,000 `APPROVED`, with rounds and steps; one top-10 Buyer as a second,
  dual-role Approver); reconciliation and the consistency check before `ANALYZE` —
  `backend/tests/plans/orders-fixture.ts` — R7, ADR-0012 2026-11-17.
- [X] T036 [US3] Plan tests, seen failing until the indexes serve them: queue page 1 and
  page 100, vendor filter, PO prefix (both lengths), the dual-role queue, each `COUNT`; the
  order lists re-run with the Approver scope now populated; no `Seq Scan` on
  `purchase_orders`, `approval_rounds`, `approval_steps`; no sort over more than page +
  offset rows; `npm run plans:orders` writes `docs/query-plans/orders/approval-queue-*.txt`
  and the re-committed list plans; the `plans` workflow checks drift —
  `backend/tests/plans/orders.plan.test.ts`, `scripts/plans-orders.ts`,
  `docs/query-plans/orders/` — FR-022, NFR-PERF-01.

**Checkpoint**: approve and the queue end to end, plans committed.

---

## Phase 6: User Story 4 — Reject (P1)

**Goal**: an Approver rejects with a reason; the order is final.

**Independent test**: reject a pending order with a reason → `REJECTED`, gone from the
queue, edit → `ORDER_LOCKED` "rejected and is closed".

- [X] T037 [P] [US4] Reject API and audit tests, seen failing: reason required (missing →
  400 `REQUIRED`; `""` or whitespace → `TOO_SHORT`, after trimming; 501 → `TOO_LONG`); → `REJECTED` (T8), current step
  `REJECTED` with reason, later steps `VOIDED`, round `REJECTED`; inactive vendor allowed;
  two-step chain, first approved, second rejected keeps the first's record; from
  `REJECTED`, submit/approve/reject/withdraw → 409 `INVALID_STATE_TRANSITION`; owner →
  403 `SELF_APPROVAL`; Approver re-check under lock as approve; one
  `APPROVAL_STEP_REJECTED` (round, step, tier, reason) — `backend/tests/integration/approvals-reject.test.ts`
  — US4 scenarios 1–5, FR-011, FR-SM-03.
- [X] T038 [P] [US4] Reject races, seen failing: approve vs reject on one step (one
  decision; status matches); reject vs the acting Approver's deactivation (rejected
  before, or 401 after) — `backend/tests/concurrency/approvals.test.ts` — R6 races 1, 5a,
  SC-005.
- [X] T039 [US4] Service, repository, route `rejectOrder` (`POST /orders/:id/reject`,
  APPROVER, `ifMatch`, `decisionReasonBody`, role details): locks order → steps → both
  `users` rows; checks in R8's order; OpenAPI, inventory, matrix pins; T037 green —
  `backend/src/approvals/` — R6, R8.
- [ ] T040 [US4] Web `RejectDialog` (required reason ≤ 500; "Rejection is final; the buyer
  must raise a new order"; safe choice focused), offered beside Approve and alone when the
  owner can't act; component tests first — `frontend/src/pages/approvals/RejectDialog.tsx`
  — US4 scenario 6.

---

## Phase 7: User Story 5 — Withdraw, change and resubmit (P1)

**Goal**: the owner withdraws a pending order with a reason, edits it and resubmits; routing
is recomputed.

**Independent test**: ₹1,50,000 submitted → withdraw → edit to ₹90,000 → submit →
auto-approved; round 1's step `VOIDED`; timeline in order.

- [X] T041 [P] [US5] Withdraw API and audit tests, seen failing: reason required (as
  reject); → `DRAFT` (T9), every step of the round `VOIDED` with any earlier approval kept,
  round `WITHDRAWN` with the reason, `submitted_at` null; editable and deletable again;
  shows the live vendor and the withdrawn round; resubmit opens round 2 under the current
  policy with a fresh snapshot; not pending → 409; stale → 409; Buyer+Approver non-owner →
  403 `NOT_ORDER_OWNER`; Approver after withdraw → 404 on the order and its timeline (S7);
  one `PO_WITHDRAWN` (round, reason, voided steps) — `backend/tests/integration/approvals-withdraw.test.ts`
  — US5 scenarios 1–3, FR-012, FR-APR-02, FR-SM-03.
- [X] T042 [P] [US5] Withdraw races, seen failing: approve vs withdraw (`APPROVED` with no
  voided step, or `DRAFT` with every step `VOIDED` and no approval); withdraw vs reject
  (`DRAFT` or `REJECTED`) — `backend/tests/concurrency/approvals.test.ts` — R6 races 2, 8,
  US5 scenario 4, SC-005.
- [X] T043 [US5] Service, repository, route `withdrawOrder` (`POST /orders/:id/withdraw`,
  BUYER, `ifMatch`, `decisionReasonBody`, role details): locks order → steps; OpenAPI,
  inventory, matrix pins; T041 green — `backend/src/approvals/` — R6, R8.
- [ ] T044 [US5] Web `WithdrawDialog` (required reason; "It returns to Draft, and approval
  starts again when you resubmit"); `ORDER_PENDING_APPROVAL` in a stale editor offers
  "Withdraw"; the withdrawn round's reason shown on the draft; component tests first —
  `frontend/src/pages/orders/WithdrawDialog.tsx`, `OrderEditor.tsx` — US5 scenario 5,
  US2 scenario 5.

---

## Phase 8: User Story 6 — Separation of duties (P1)

- [ ] T045 [US6] Separation-of-duties suite, gathered by requirement (the
  `SELF_APPROVAL` cells were seen failing first in T027 and T037, the database half in
  T012): a Buyer+Approver approving another buyer's order succeeds with `actingRole`
  `APPROVER`; their own pending order is in their order list but never in their queue or
  count; no `DUPLICATE_APPROVER` in the registry or source — `backend/tests/integration/approvals-sod.test.ts`
  — US6 scenarios 2–4, FR-013, FR-SOD-01, SC-004.
- [ ] T046 [US6] Web: no Approve or Reject on an order the caller owns; component test —
  `frontend/src/pages/orders/OrderDetail.tsx` — US6 scenario 3.

---

## Phase 9: User Story 8 — Visibility of submitted orders (P1)

- [ ] T047 [US8] Authorization matrix rows for `DRAFT`, `PENDING_APPROVAL`, `APPROVED`,
  `REJECTED` × owner Buyer, other Buyer, Approver, Buyer+Approver (owner and not), Admin,
  no role, anonymous, for read, list, timeline, edit, delete, submit, withdraw, approve,
  reject, queue, count, policy; the exact codes and role details of ADR-0004 (2026-11-17,
  S1–S7); generated from the route table — `backend/tests/integration/authorization-matrix.test.ts`
  — FR-019, FR-OWN-01, NFR-AUTH-02, SC-007.
- [ ] T048 [US8] Web: Approvers' order list shows non-draft orders (slice 3's empty state
  removed); role details on `FORBIDDEN`; component tests — `frontend/src/pages/orders/OrdersList.tsx`
  — US8, contracts/ui.md.
- [ ] T049 [US8] `/security-review` of the permission changes (CLAUDE.md: permissions
  stories): route role details (T007), the order-level 403s, the under-lock re-check of
  owner and Approver, the queue scope, `ownerCanAct` exposure, the `SECURITY DEFINER`
  policy function and the actor switch; fix findings tests first — review notes in the
  plan's slice-end section — Principle III, IX.

---

## Phase 10: User Story 7 — Approval policy CLI (P2)

- [ ] T050 [P] [US7] CLI tests, seen failing: `policy:set --tier1 200000` → version 2,
  next submission uses it, earlier orders keep version 1; same value → no-op, exit 0, no
  version; `0`, negative, 5 decimals, `abc` → non-zero exit, no version; audited
  `APPROVAL_POLICY_CHANGED` `OPERATOR` with before → after, `osUser`, `host`;
  `policy:show` prints version, tiers, effective time; `set_approval_policy` under a USER
  context → `PO017` — `backend/tests/integration/cli-policy.test.ts` — US7, FR-015,
  FR-APR-05.
- [ ] T051 [US7] `policy:set`, `policy:show` commands (advisory lock, exit codes as the
  admin commands) calling `set_approval_policy` through `backend/src/approvals/policy.ts`;
  T050 green — `backend/src/cli/commands/policy-set.ts`, `policy-show.ts`,
  `backend/src/cli/admin.ts` — R1.

---

## Phase 11: Polish & cross-cutting

- [ ] T052 [P] Service timings on the plan fixture: submit a 500-line order p95 ≤ 500 ms,
  one approval ≤ 150 ms, queue page 1 ≤ 150 ms; results recorded in R7 —
  `backend/tests/plans/orders.timing.test.ts` — FR-022, SC-006.
- [ ] T053 [P] Demo seed: per demo Buyer one order in each reachable state (draft,
  pending, auto-approved, step-approved, rejected, withdrawn draft) through the services;
  reconciliation zero rows after — `backend/src/migrate/seed-demo.ts`,
  `backend/tests/integration/seed-demo.test.ts` — FR-025.
- [ ] T054 E2E: create → submit ≤ threshold → auto-approved, Edit gone; create → submit >
  threshold → queue and nav count → approve; submit → reject → stale edit shows the
  rejected message; submit → withdraw → edit → resubmit re-routes; Buyer+Approver's own
  order not in their queue, no Approve; axe on each new screen and dialog; the four dialogs
  in the Playwright dialog checks — `frontend/e2e/approvals.spec.ts` — FR-024, NFR-FE-07,
  NFR-FE-09. Run `npm run e2e:local`.
- [ ] T055 Traceability: FR-APR-01, FR-APR-02, FR-APR-03, FR-APR-04, FR-APR-05,
  FR-SM-01, FR-SM-03, FR-SOD-01, FR-VEN-03, FR-LCK-01 (pending/approved/rejected parts),
  FR-OWN-01 (non-draft cells), FR-ACT-01 (approve row), NFR-AUTH-01/02, NFR-AUD-01
  (decisions), NFR-AUD-03 (Approver timelines), NFR-CON-01, NFR-CON-03, NFR-PERF-01 (queue),
  NFR-FE-07/08/09 parts — each with its passing test; `npm run check:traceability` green —
  `docs/traceability.md`.
- [ ] T056 Quickstart run and results — `specs/005-submit-approve/quickstart-results.md`.
- [ ] T057 Slice-end review: `/code-review`, `/security-review` (permissions, SECURITY
  DEFINER policy function, actor switching), constitution pass; fix findings; full gate,
  lint, typecheck green.

---

## Owner requirements → tasks

| Requirement (2026-11-17) | Tasks |
|---|---|
| Rounds/steps immutable, database refusals D1–D8 | T002, T003, T012, T013, T015 |
| Routing exact in SQL, policy version bound | T017, T019, T022, T023 |
| Vendor snapshot and locked columns | T002, T012, T018, T025 |
| Auto-approval as `SYSTEM` in the submit transaction | T009, T020, T023; D6 in T012 |
| One lock order, users rows last in id order, no user-then-order | T028, T031, T032, T039 |
| Races: approve vs reject, withdraw, edit vs submit, owner and Approver deactivation/role removal | T019, T028, T038, T042 |
| Queue and nav count: partial indexes, plans, oldest first, never own | T029, T031, T035, T036, T052 |
| Five codes; S1–S7; role-specific `FORBIDDEN` messages | T006, T007, T011, T016, T027, T047, T048 |
| `ORDER_LOCKED` message by status; copy-order deferred | T006, T011, T016 |

## Dependencies and execution order

- Setup (T001) → Foundational (T002–T011) → US2 (T012–T016) → US1 (T017–T026) → US3
  (T027–T036) → US4 (T037–T040) → US5 (T041–T044) → US6 (T045–T046) → US8 (T047–T049) →
  US7 (T050–T051) → Polish (T052–T057).
- Foundational: T002 → T003 → T004; T005, T006, T008, T010, T011 in parallel after T003;
  T007 after T006; T009 independent.
- US2: T012–T014 seen failing on part 1 → T015 (part 2) → T016.
- US1: T017–T021 → T022 → T023 → T024 → T025 → T026. US3 needs T022's lock helper.
- US3: T027–T030 → T031 → T032 → T033 → T034; T035 → T036 after T033.
- US4 and US5 reuse US3's step locking; US6 and US8 need every command.
- T052, T053 in parallel after US7; T054 → T055 → T056 → T057.

## Parallel examples

- Foundational: T005, T006, T008, T010, T011 together.
- US2: T012, T013, T014 together; then T015.
- US1: T017, T018, T019, T020, T021 together.
- US3: T027, T028, T029, T030 together.
- Polish: T052, T053 together.

## Implementation strategy

The database rules first (US2): before any approvals code, no path can produce a status,
round or step the state machine forbids. MVP is US1 (submit with routing and
auto-approval). US3 adds the Approver's half and the queue with committed plans; US4 and
US5 close the remaining transitions; US6 and US8 prove separation of duties and the
matrix; US7 adds the policy CLI. Each story: tests first, seen failing against real
PostgreSQL, then code; a short summary stop after each story.
