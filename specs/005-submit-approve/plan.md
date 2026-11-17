# Implementation Plan: Slice 4 — Submission, routing, approval, rejection and withdrawal

**Branch**: `005-submit-approve` | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-submit-approve/spec.md`

## Summary

A draft leaves `DRAFT` and reaches a decision (brief §3.4, §3.5, §8):
- submit, routed in SQL by the exact total against the current, immutable policy version:
  at or below the lowest tier auto-approved as `SYSTEM` in the same transaction; above it
  `PENDING_APPROVAL` with one step per tier exceeded
- approve (step by step), reject (final) and withdraw (back to draft, steps voided), each
  with `If-Match`, `SELF_APPROVAL`, and approve refused while the vendor is inactive or the
  owner can't act
- approval rounds (one per submission, with its policy version, total and vendor snapshot)
  and steps (one per tier), immutable once decided; a commit-time check re-derives the
  chain and refuses any status, round or step that disagrees
- the specific `409`s for edits of submitted orders, `NOT_ORDER_OWNER`
- the approval queue (never the caller's own orders) and the nav count, on partial indexes,
  with plans at ADR-0012's dataset
- the policy: versioned rows, written only through an `OPERATOR`-only function from the CLI,
  readable by every role
- web: Submit, Withdraw, Approve, Reject dialogs, the approval panel, the queue screen, the
  nav count, the owner-can't-act marker

Decisions in [research.md](research.md) (R1–R12); tables in
[data-model.md](data-model.md); reviewed schemas, operations and OpenAPI diff in
[contracts/api.md](contracts/api.md), with [errors.md](contracts/errors.md) and
[ui.md](contracts/ui.md).

## Technical Context

**Language/Version**: TypeScript 6 (`strict`) on Node.js 24; SQL for PostgreSQL 17

**Primary Dependencies**: the slice 0–3 stack; no new dependency.

**Storage**: PostgreSQL 17. New tables `approval_policies`, `approval_policy_tiers`,
`approval_rounds`, `approval_steps`; `purchase_orders` gains `current_round`,
`submitted_at`, `approved_at`; five transition rows (migration `0014_approvals`).

**Testing**: Vitest + Supertest + Testcontainers PostgreSQL 17 (no DB mocks); state
machine (one test per transition, allowed and refused), approval routing (seed boundaries;
two- and three-tier fixtures), locked orders, approval integrity attacks (raw SQL as
`po_app` and as a privileged role against every rule D1–D8), concurrency (research R6's
races, barriers), authorization matrix rows for four states, audit payloads, plan and
timing tests; Testing Library + vitest-axe + MSW; Playwright + axe.

**Target Platform**: the existing docker compose stack; no config change.

**Project Type**: web application (API + SPA), npm workspaces.

**Performance Goals**: ADR-0012: submit a 500-line order p95 ≤ 500 ms; one approval
≤ 150 ms; approval queue ≤ 150 ms. Plans at 100k orders (3,000 pending), ~1M lines, ~2M
audit entries.

**Constraints**: routing only in SQL, exact `numeric`; every state rule enforced by the
database; one lock order per command, `users` last; no HTTP write to the policy; the
contract additive.

**Scale/Scope**: 6 new operations, 2 changed; 4 tables, 3 order columns, 6 indexes;
6 SQLSTATEs; 5 registry codes (2 new); 5 order audit events; 1 new screen, 4 dialogs, nav
count; 2 CLI commands.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this slice complies | Status |
|---|---|---|
| I. Derived-value integrity | Lines stay locked outside `DRAFT` (`PO006`); the round's `total` is checked equal to the order's at commit; reconciliation gains the approval-consistency branch and still runs after every suite and seed | Pass |
| II. State machine | Five transition rows; status, round and step states checked together at commit (`PO014`); decisions only on the current step; routing re-derived by the database from policy data, no tier count special-cased; decisions bound to `decided_version`; policy versions immutable | Pass |
| III. Authorization | Route roles before validation, with role-specific `FORBIDDEN` messages; 404 → `NOT_ORDER_OWNER` / `SELF_APPROVAL` → 409 under lock; `SELF_APPROVAL` also in the database (`PO016`); owner able to act and the acting Approver re-checked under `FOR SHARE`; queue scoped in SQL; matrix cells S1–S7 signed off and written into ADR-0004 (R9) | Pass |
| IV. Audit | Five order events plus `APPROVAL_POLICY_CHANGED`, each in its change's transaction; auto-approval as `SYSTEM` in the submit transaction, enforced by D6; payloads carry the round | Pass |
| V. Concurrency | One lock order per command (ADR-0006 amended), `users` rows last in id order; no user-then-order lock; `If-Match` on all four commands; nine races plus deadlock tests for owner and Approver, business outcomes asserted | Pass |
| VI. API contract | Zod first; additive OpenAPI; five registry entries tests-first; bodies strict; body inventory | Pass |
| VII. Performance | Partial indexes for the queue; deferred-join page and one-statement count; committed plans for the queue and the re-committed order lists at 100k orders; timing tests | Pass |
| VIII. Test-first | Each story's tests first, seen failing against Testcontainers | Pass |
| IX. Operability and security | No new config or secret; policy writes need the `OPERATOR` context, which only the CLI sets; CSRF on the four writes | Pass |
| X. Brief binding | §3.4, §3.5, §8 rows; owner decisions recorded as ADR updates; matrix changes held for sign-off | Pass |
| XI. Code clarity | `approvals/` area (routes → service → repository) beside `orders/`; constants once, SQL copies pinned; IDs only in test names | Pass |
| XII. Simplicity | No new dependency or service; no queue table; the snapshot as one validated document | Pass |
| XIII. Frontend | ConfirmDialog for submit, withdraw, approve, reject (ADR-0018 text); errors by `code`; nav count; axe | Pass |

**Gate result (pre-research)**: PASS.

**Re-check after Phase 1 design**: PASS, no deviation. ADR updates made with this plan
(2026-11-17): ADR-0001 (rounds and steps; what the database refuses), ADR-0002 (policy
storage, the `OPERATOR`-only write function, routing in SQL), ADR-0006 (lock order per
command; no user-then-order lock; races), ADR-0012 (dataset status mix), ADR-0016
(approval payloads carry the round; `PO_SUBMITTED` the vendor snapshot). Spec corrected:
US2 scenario 3 and FR-008 (a pure Approver is refused at the route), the reason rules.
ADR-0004: cells S1–S7, the role-specific `FORBIDDEN` messages and the under-lock
re-check of the acting Approver (owner sign-off, 2026-11-17); ADR-0006: approve and reject
lock the owner's and Approver's `users` rows last, in id order.

## Project Structure

### Documentation (this feature)

```text
specs/005-submit-approve/
├── spec.md, checklists/requirements.md
├── plan.md            # this file
├── research.md        # R1–R12
├── data-model.md      # migration 0014, triggers, consistency check, audit events
├── quickstart.md
├── contracts/         # api.md, errors.md, ui.md
└── tasks.md           # /speckit-tasks
```

### Source Code (new and changed)

```text
packages/contracts/src/
├── approvals.ts                 # constants (R1, R2, R8)
├── schemas/approvals.ts         # reason body, round, step, snapshot, queue, policy
├── schemas/orders.ts            # order gains approval fields; read-only list
├── errors.ts                    # + 5 codes
└── operations.ts                # + 6 operations; edit/delete errors
backend/prisma/migrations/0014_approvals/migration.sql
backend/prisma/schema.prisma
backend/src/
├── approvals/
│   ├── routes.ts  service.ts  repository.ts   # submit, approve, reject, withdraw, queue, policy read
│   └── policy.ts                              # set/show for the CLI
├── orders/service.ts            # NOT_ORDER_OWNER, ORDER_PENDING_APPROVAL, ORDER_LOCKED; reads
├── orders/repository.ts         # order read with round and steps; list snapshot name
├── db/transaction.ts            # asSystem (R5)
├── db/errors.ts                 # PO012–PO017
├── db/reconciliation.sql        # + approval consistency
├── audit/events.ts              # + 5 order events
├── cli/commands/policy-set.ts, policy-show.ts
└── migrate/seed-demo.ts         # one order per reachable state
backend/tests/
├── integration/approvals-*.test.ts, approval-policy.test.ts, approval-triggers.test.ts,
│   orders-lock.test.ts, cli-policy.test.ts, authorization-matrix (rows), route-table
├── integrity/approval-attacks.test.ts, reconciliation.test.ts
├── concurrency/approvals.test.ts            # research R6 races + deadlock test
└── plans/orders-fixture.ts (status mix), orders.plan.test.ts (+ queue), orders.timing.test.ts
docs/query-plans/orders/approval-queue-*.txt
frontend/src/
├── pages/orders/OrderDetail.tsx, ApprovalPanel.tsx, SubmitDialog.tsx, WithdrawDialog.tsx
├── pages/approvals/ApprovalQueue.tsx, ApproveDialog.tsx, RejectDialog.tsx, queries.ts
├── app/Shell.tsx (nav count), router.tsx
└── errors/messages.ts
frontend/e2e/approvals.spec.ts
```

**Structure Decision**: a new `approvals/` area owns the four commands, the queue and the
policy, because they share the round and step repository; `orders/` keeps create, edit,
delete, reads and lists, and gains only the lock codes and the richer read. The order lock
helper is shared from `orders/repository.ts`, so every command uses the same first lock.

## Story order for `/speckit-tasks`

0. **Foundational**: migration 0014 part 1 (policy tables and seed, rounds, steps, order
   columns, transitions, grants, indexes); contracts (constants, schemas, five codes,
   operations, inventory); `asSystem`; audit events; frontend routes and messages.
1. **US2 Locked orders + integrity** (P1), first because every later story relies on the
   database rules: trigger and attack tests seen failing on part 1, then part 2 (the
   guards and `order_approval_consistent`); the lock codes in the order service.
2. **US1 Submit and routing** (P1): seed boundaries, multi-tier fixtures, snapshot,
   auto-approval as `SYSTEM`; the policy read endpoint `GET /approval-policy` (the Submit
   dialog needs it); Submit dialog.
3. **US3 Approve and the queue** (P1): step decisions, owner-can-act under lock, queue and
   count; queue screen, Approve dialog, nav count; plans and timings.
4. **US4 Reject** (P1) and **US5 Withdraw and resubmit** (P1).
5. **US6 Separation of duties** and **US8 Visibility** (P1): matrix rows for four states
   (after R9 sign-off).
6. **US7 Policy** (P2): CLI `policy:set`/`policy:show` (the read endpoint lands with
   US1).
7. **Polish**: concurrency suite, demo seed, e2e, traceability rows (FR-APR-01..05,
   FR-SM-01, FR-SM-03, FR-SOD-01, FR-LCK-01 part, FR-VEN-03, NFR rows), quickstart run.

Each story: tests first, seen failing against real PostgreSQL, then code.

## Complexity Tracking

No constitution violation to justify.
