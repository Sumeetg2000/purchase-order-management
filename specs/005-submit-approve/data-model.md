# Data model: Slice 4 — Submission, routing, approval, rejection and withdrawal

Migration `backend/prisma/migrations/0014_approvals/migration.sql`, run as `po_owner`.
Decisions are in [research.md](research.md); numbers and lists are constants in
`packages/contracts/src/approvals.ts` and `orders.ts`, pinned to their SQL copies by
`order-constants.test.ts`.

## Table `approval_policies` (R1)

| Column | Type | Rules |
|---|---|---|
| `version` | `integer` PK | ≥ 1; the highest is current |
| `effective_at` | `timestamptz` | `now()` at insert |
| `created_at` | `timestamptz` | `now()` |

## Table `approval_policy_tiers` (R1)

| Column | Type | Rules |
|---|---|---|
| `policy_version` | `integer` → `approval_policies` | |
| `tier` | `smallint` | ≥ 1; PK `(policy_version, tier)` |
| `threshold` | `numeric(22,4)` | > 0; strictly increasing with `tier` (checked by `set_approval_policy`) |

Both tables: `po_app` `SELECT` only; `BEFORE UPDATE OR DELETE` → `PO017` for every role.
Seed: version 1, tier 1 = `100000.0000`, audited `APPROVAL_POLICY_CHANGED` (`SYSTEM`).

## Table `approval_rounds` (R2, R4): one row per submission

| Column | Type | Rules |
|---|---|---|
| `order_id` | `uuid` → `purchase_orders` `ON DELETE CASCADE` | |
| `round` | `smallint` | ≥ 1; PK `(order_id, round)`; = the order's `coalesce(current_round, 0) + 1` at insert |
| `policy_version` | `integer` → `approval_policies` | the highest version, read by the insert |
| `total` | `numeric(22,4)` | the order's total at submit |
| `vendor_snapshot` | `jsonb` | object with `id`, `name`, `contactName`, `contactEmail`, `contactPhone`, `paymentTerms` (`CHECK`) |
| `submitted_by` | `uuid` → `users` | the owner |
| `submitted_at` | `timestamptz` | `now()` |
| `outcome` | `text` null | `AUTO_APPROVED`, `APPROVED`, `REJECTED`, `WITHDRAWN` (`APPROVAL_ROUND_OUTCOMES`) |
| `closed_at` | `timestamptz` null | `CHECK ((outcome IS NULL) = (closed_at IS NULL))` |
| `withdraw_reason` | `text` null | `CHECK ((outcome = 'WITHDRAWN') = (withdraw_reason IS NOT NULL))`; plain text ≤ 500 |

`po_app`: `SELECT`; `INSERT (order_id, round, policy_version, total, vendor_snapshot,
submitted_by)`; `UPDATE (outcome, closed_at, withdraw_reason)`.

## Table `approval_steps` (R2): one row per tier step

| Column | Type | Rules |
|---|---|---|
| `order_id`, `round` | → `approval_rounds` `ON DELETE CASCADE` | |
| `step` | `smallint` | ≥ 1; PK `(order_id, round, step)` |
| `tier` | `smallint` | |
| `threshold` | `numeric(22,4)` | the tier's threshold under the round's policy |
| `state` | `text` | `OPEN`, `APPROVED`, `REJECTED`, `VOIDED` (`APPROVAL_STEP_STATES`); inserted `OPEN` |
| `decided_by` | `uuid` → `users` null | the acting user |
| `decided_at` | `timestamptz` null | `now()` |
| `decided_version` | `integer` null | the order's version the decision was made against |
| `reason` | `text` null | rejection only; plain text ≤ 500 |
| `voided_at` | `timestamptz` null | |

Shape `CHECK` per state: `OPEN` → all decision and void columns null; `APPROVED` →
decision set, `reason` null, `voided_at` null; `REJECTED` → decision and `reason` set,
`voided_at` null; `VOIDED` → `voided_at` set, `reason` null (decision kept if it was
approved).

`po_app`: `SELECT`; `INSERT (order_id, round, step, tier, threshold)`; `UPDATE (state,
decided_by, decided_at, decided_version, reason, voided_at)`.

## `purchase_orders`: new columns (R4)

| Column | Type | Rules |
|---|---|---|
| `current_round` | `smallint` null | null until the first submit; never decreases |
| `submitted_at` | `timestamptz` null | the current round's while not a draft; null on a draft |
| `approved_at` | `timestamptz` null | set on → `APPROVED`; kept on → `CANCELLED` (slice 5) |

`CHECK ((status = 'DRAFT') = (submitted_at IS NULL))`;
`CHECK ((status IN ('APPROVED', 'CANCELLED')) = (approved_at IS NOT NULL))`.
`po_app` gains `UPDATE (status, current_round, submitted_at, approved_at)`.

## `order_status_transitions`: rows inserted

`DRAFT → APPROVED` (T4), `DRAFT → PENDING_APPROVAL` (T5), `PENDING_APPROVAL → APPROVED`
(T7), `PENDING_APPROVAL → REJECTED` (T8), `PENDING_APPROVAL → DRAFT` (T9). A test pins the
set to `ORDER_TRANSITIONS` in the contracts.

## Indexes (R7)

| Index | Serves |
|---|---|
| `purchase_orders (submitted_at, id) INCLUDE (owner_id) WHERE status = 'PENDING_APPROVAL'` | queue, its count, nav count |
| `purchase_orders (vendor_id, submitted_at, id) INCLUDE (owner_id) WHERE status = 'PENDING_APPROVAL'` | queue + vendor |
| `purchase_orders (po_number) INCLUDE (owner_id) WHERE status = 'PENDING_APPROVAL'` | queue + PO prefix |
| `approval_steps (decided_by) WHERE decided_by IS NOT NULL` | FK on user (no seq scan on a user's key change) |
| `approval_rounds (submitted_by)` | FK on user |
| `approval_rounds (policy_version)` | FK on policy |

PKs serve every per-order lookup of rounds and steps.

## Triggers and functions

| Name | On | Kind | Refuses |
|---|---|---|---|
| `set_approval_policy(numeric[])` | — | function, `SECURITY DEFINER`, `EXECUTE` to `po_app` | non-`OPERATOR` context, invalid tiers (`PO017`); no-op on equal tiers |
| `approval_policy_immutable` | both policy tables | before update/delete, row | any change (`PO017`) |
| `approval_rounds_guard` | `approval_rounds` | before insert/update/delete, row | insert unless the order is `DRAFT` and this is its next round; `AUTO_APPROVED` outside `SYSTEM`; any update but `outcome`/`closed_at`/`withdraw_reason` set once from null; delete while the order exists (`PO013`) |
| `approval_steps_guard` | `approval_steps` | before insert/update/delete, row | insert unless `OPEN` in the order's open next round; a decision unless on the lowest open step of the current round of a `PENDING_APPROVAL` order (`PO012`); `decided_by` ≠ the acting user or = the owner (`PO016`); moves other than `OPEN→APPROVED/REJECTED/VOIDED`, `APPROVED→VOIDED`; any change once the round is closed; delete while the order exists (`PO012`) |
| `purchase_orders_submission_lock` | `purchase_orders` | before update, row | `vendor_id` changed unless `DRAFT` before and after; `current_round`, `submitted_at`, `approved_at` changed without a status change in the same row update (`PO015`) |
| `order_approval_consistent` | `purchase_orders` (update), `approval_rounds`, `approval_steps` (insert, update) | deferred constraint, row: fires at commit once per changed row, so a command checks its order at most 2 + tier-count times (one step row per tier; three with the seed policy); each run reads one order, its rounds and their steps by primary key | any mismatch between status, round, expected chain (re-derived from the policy tiers and the round's total), step states, `submitted_at`, `approved_at` (`PO014`; research R2 D1) |

All trigger functions `SET search_path = pg_catalog, pg_temp`, `REVOKE ALL … FROM PUBLIC`.
New SQLSTATEs `PO012`–`PO017` map to `INTERNAL_ERROR` in `db/errors.ts`.

## Reconciliation

`backend/src/db/reconciliation.sql` gains a branch returning every order for which
`order_approval_consistent` would fail (so a privileged edit with triggers off is caught
by the after-every-suite check too).

## Audit events (ADR-0016, amended 2026-11-17)

| Action | Actor | Details |
|---|---|---|
| `PO_SUBMITTED` | owner (`BUYER`) | round, total, policy version, tiers in chain, resulting status, vendor snapshot |
| `PO_AUTO_APPROVED` | `SYSTEM` | round, threshold (the lowest tier), policy version |
| `APPROVAL_STEP_APPROVED` | Approver (`APPROVER`) | round, step, tier, version approved |
| `APPROVAL_STEP_REJECTED` | Approver (`APPROVER`) | round, step, tier, reason |
| `PO_WITHDRAWN` | owner (`BUYER`) | round, reason, voided steps (step, tier, earlier decision if any) |
| `APPROVAL_POLICY_CHANGED` | `OPERATOR` (`SYSTEM` for the seed) | version and tiers before → after; `osUser`, `host` |

`ORDER_AUDIT_ACTIONS` gains the five order events.

## State transitions (ADR-0001)

```text
          submit ≤ tier1 (SYSTEM)                 
  DRAFT ─────────────────────────────► APPROVED ──(slice 5: cancel)──► CANCELLED
    │  ▲                                  ▲
    │  │ withdraw (owner, reason)         │ approve last step (T7)
    │  │                                  │
    └──┴──► PENDING_APPROVAL ─────────────┤ approve non-final step (T6, stays)
  submit > tier1 (T5)       │
                            └── reject (Approver, reason, T8) ──► REJECTED (final)
```

Each command bumps the order's `version` by one (T6 included).

## Demo seed and plan fixture

- Demo seed: one order per reachable state per demo Buyer, through the services (R12).
- Plan fixture (`backend/tests/plans/orders-fixture.ts`): 5,000 `DRAFT`, 3,000
  `PENDING_APPROVAL`, 2,000 `REJECTED`, 90,000 `APPROVED`, with rounds and steps; a second,
  dual-role Approver among the top Buyers; reconciliation and the consistency check
  before `ANALYZE` (R7, ADR-0012 amended).
