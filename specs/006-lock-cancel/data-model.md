# Data model: Slice 5 — Cancel and the remaining locks

Migration `0015_cancel` (PostgreSQL 17). Decisions in [research.md](research.md) R1–R3,
R7, R8.

## `purchase_orders` (changed)

| Column | Type | Rule |
|---|---|---|
| `cancelled_by` | `uuid` null, FK `users (id)` | the acting Approver; never the owner (D11) |
| `cancelled_at` | `timestamptz` null | database clock, set by the guard (D10) |
| `cancel_reason` | `text` null | trimmed, 1–500 characters, line breaks allowed |

Constraints:
- `purchase_orders_cancel_matches_status`:
  `(status = 'CANCELLED') = (cancelled_by IS NOT NULL)` and the same for `cancelled_at`
  and `cancel_reason` (all three set iff cancelled).
- `purchase_orders_cancel_reason_valid`: the ADR-0007 reason rule, as
  `approval_rounds_withdraw_reason_valid`.
- Existing `purchase_orders_approved_matches_status` already keeps `approved_at` on a
  cancelled order.

Index: `purchase_orders_cancelled_by_idx ON purchase_orders (cancelled_by) WHERE
cancelled_by IS NOT NULL` (foreign key only; signed off, R10 Q5). No filter index (R8).

## `order_status_transitions`

Adds `('APPROVED', 'CANCELLED')` (ADR-0001 T10). `ORDER_TRANSITIONS` in contracts gains
the pair; the existing pin test keeps SQL and TypeScript equal.

## Triggers and functions

| Name | When | Rule |
|---|---|---|
| `purchase_orders_cancel_guard()` | `BEFORE UPDATE ON purchase_orders` | D9: `OLD.status IN ('REJECTED', 'CANCELLED')` → `PO018 ORDER_CLOSED`. D10: cancel columns differ from `OLD` unless `NEW.status = 'CANCELLED'` → `PO019 ORDER_CANCEL_REFUSED` (a change to `CANCELLED` from any state but `APPROVED` is left to the transitions table, `PO009`); on the `APPROVED → CANCELLED` update any column other than `status`, `version` (+1 exactly), `updated_at` and the cancel columns differs → `PO019`; sets `NEW.cancelled_at := now()`. D11: when `cancelled_by` is set, `app.actor_type` ≠ `USER`, `cancelled_by` ≠ acting user, or `cancelled_by = owner_id` → `PO016` (a missing record is left to the CHECK, `23514`) |
| `approval_inconsistency(uuid)` | replaced | gains the `CANCELLED` branch: current round closed `AUTO_APPROVED` with no steps, or `APPROVED` with every step approved; `approved_at` = round's `closed_at`. The `ELSE` ("not reachable yet") is removed: every status is now handled |

The guard runs as `SECURITY INVOKER` with a pinned `search_path`, `REVOKE ALL … FROM
PUBLIC`, as slice 4's guards. `BEFORE UPDATE` triggers fire in name order:
`purchase_orders_cancel_guard` sorts first, so D9 refuses an update of a rejected or
cancelled order before any other guard runs, and `purchase_orders_set_updated_at` runs after it (D10
ignores `updated_at`).

SQLSTATE map (`backend/src/db/errors.ts`): `PO018 → ORDER_CLOSED`,
`PO019 → ORDER_CANCEL_REFUSED`. Both reach the API only as `500` from an attack, as
slice 4's guard codes; the service refuses first.

## Lock order (ADR-0006 row to add)

| Command | Locks, in order |
|---|---|
| cancel | order `FOR UPDATE` → the acting Approver's `users` row `FOR SHARE` (then `FOR KEY SHARE` of `cancelled_by` on the same row) |

## Audit

`PO_CANCELLED` (ADR-0016): actor `USER`, acting role `APPROVER`, `details`:
`{ round, reason, lines: [{ lineId, position, quantity, receivedQuantity }] }`, lines in
position order. Schema in `backend/src/audit/events.ts`.

## Plan fixture (ADR-0012 amendment, signed off R10 Q6)

1,000 of the 90,000 approved orders become `CANCELLED` (n % 100 in a fixed band), each
with `cancelled_by` the fixture Approver, `cancelled_at` after `approved_at`, and a
reason; their rounds stay closed approved.

## State transitions after this slice

`DRAFT → PENDING_APPROVAL | APPROVED` (submit) · `PENDING_APPROVAL → APPROVED | REJECTED |
DRAFT` · `APPROVED → CANCELLED` (cancel, new). `REJECTED` and `CANCELLED` are final.
