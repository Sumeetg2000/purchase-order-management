# ADR-0001: Order lifecycle, state table and PO numbering

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (state table moved here from the
  constitution; single-step approval guards; financial-year PO numbering)
- **Brief:** §1, §3.2, §3.4, §3.5 · Gaps G25, Q4
- **Principles:** II, I, IV

## Context
Brief §3.2 lets the initial state depend on the total ("document which"). §3.4 asks what
happens when lines change mid-approval. §3.5 locks approved orders. The background
complains of "no numbering discipline".

## Decision

### States
- Five stored states: `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `CANCELLED`.
  `REJECTED` and `CANCELLED` are final.
- Receipt progress (`NOT_RECEIVED`, `PARTIALLY_RECEIVED`, `FULLY_RECEIVED`) is derived from
  line quantities and never stored.
- Every order is created in `DRAFT`. On submit, the total routes it: at or below the
  lowest tier it becomes `APPROVED` (actor `SYSTEM`); above it, it becomes
  `PENDING_APPROVAL` with a fresh chain (ADR-0002).

### State table
| # | Transition | Action, actor | Guard (all must hold) |
|---|---|---|---|
| T1 | ∅ → `DRAFT` | Create, Buyer | Vendor exists and is active; 1–500 valid lines; PO number assigned; caller becomes owner |
| T2 | `DRAFT` → `DRAFT` | Edit header, vendor or lines, owner | Vendor active; 1–500 lines; version matches |
| T3 | `DRAFT` → (deleted) | Delete draft, owner | Version matches; hard delete of order and lines; `PO_DRAFT_DELETED` records the PO number and contents; reason optional |
| T4 | `DRAFT` → `APPROVED` | Submit, owner | Version matches; total at or below the lowest tier; vendor active; vendor snapshot taken; `PO_AUTO_APPROVED` with actor `SYSTEM` |
| T5 | `DRAFT` → `PENDING_APPROVAL` | Submit, owner | Version matches; total above the lowest tier; vendor active; vendor snapshot taken; a fresh chain built from policy data |
| T6 | `PENDING_APPROVAL` → `PENDING_APPROVAL` | Approve a non-final step, Approver | Caller ≠ owner; vendor active; version matches; more steps remain (only reachable with a multi-tier policy) |
| T7 | `PENDING_APPROVAL` → `APPROVED` | Approve the final step, Approver | Same as T6, and this is the last step |
| T8 | `PENDING_APPROVAL` → `REJECTED` | Reject, Approver | Caller ≠ owner; version matches; reason required. Allowed even if the vendor is inactive |
| T9 | `PENDING_APPROVAL` → `DRAFT` | Withdraw, owner | Version matches; reason required; every step of the current round marked `VOIDED`, decided steps keep their record |
| T10 | `APPROVED` → `CANCELLED` | Cancel, Approver | Caller ≠ owner; version matches; reason required; not fully received (`409 ORDER_FULLY_RECEIVED`). Allowed after vendor deactivation |

- Goods receipt is not a transition. The owner records receipts against `APPROVED` orders
  only (`409 ORDER_NOT_RECEIVABLE` otherwise), including after vendor deactivation.
- Any other (state, action) pair → `409 INVALID_STATE_TRANSITION`, with the current status
  and the attempted action in `details`.
- **Database enforcement**:
  - A trigger rejects any status change not in the table.
  - It also rejects `→ APPROVED` unless the current round's chain is complete or a
    `SYSTEM` auto-approval exists.
  - A trigger allows `DELETE` of an order only while it's `DRAFT`. Lines may change only
    while their order is `DRAFT`.
- **Locked orders**: in every non-draft state, lines, vendor and header are immutable (the
  database trigger above).
  - In the API, editing an `APPROVED`, `REJECTED` or `CANCELLED` order →
    `409 ORDER_LOCKED`, with the current status in `details`.
  - Editing a `PENDING_APPROVAL` order → `409 INVALID_STATE_TRANSITION`. The owner
    withdraws, edits and resubmits. Routing is recomputed, and resubmission always builds a
    fresh chain.
- Cancellation is a distinct `PO_CANCELLED` event with a reason, never an edit.

### PO numbers
- Format `PO-{FY}-{seq:06d}`, for example `PO-2026-27-000123`. Hyphens only, so the number
  is URL-safe. The sequence is zero-padded to at least 6 digits and simply grows wider
  past 999,999.
- **FY** is the Indian financial year, April–March, computed from the database clock in
  `Asia/Kolkata`:
  - 1 April 2026 00:00 IST to 31 March 2027 23:59:59.999 IST → `2026-27`
- The sequence restarts at 1 for each FY. It's held in a counters table
  `po_number_counters (fy PRIMARY KEY, last_value)`.
- Allocation runs as **one short statement before the create transaction**, so the
  counter row is never held locked for the length of a create:
  `INSERT … VALUES (fy, 1) ON CONFLICT (fy) DO UPDATE SET last_value = last_value + 1
  RETURNING last_value`.
  - This is the `UPDATE … RETURNING`, plus the first allocation of a new FY.
  - The app role has `INSERT`/`UPDATE` on the counters table only.
- Each number is unique (a `UNIQUE` constraint), never reused and never editable (a
  trigger refuses changes; `poNumber` in any body → 400).
- **Gaps are acceptable**: a failed or rolled-back create, an idempotent replay that
  allocated first, and deleted drafts. Each deleted draft is explained by its audit entry.

## Alternatives
- Create directly into `PENDING_APPROVAL`/`APPROVED`: no working draft, and every typo
  needs a new order.
- Auto-revert to `DRAFT` on any pending edit (the old T8): makes approval state change as a
  side effect of an edit. Rejected in favour of an explicit, audited withdraw.
- A `DISCARDED` state: rejected. Hard delete plus the audit entry keeps history without a
  dead state.
- Reject → `DRAFT`: one order number would cycle through rounds. Rejected.
- Calendar-year numbering `PO-{YYYY}-…` (the earlier draft): Indian companies keep books by
  financial year, so numbers should restart in April. Replaced.
- A PostgreSQL sequence per FY: needs DDL at each year boundary. The counters table needs
  none.
- Allocating inside the create transaction: holds the counter row lock for the whole create
  and serialises concurrent creates. Rejected.

## Consequences
- §3.4 answer: "edits mid-approval are refused; withdraw, edit, resubmit, and routing is
  recomputed from the new total."
- A buyer re-enters a rejected order (copy-order is out of scope).

## Tests
- One test per transition, allowed and refused.
- The submit → withdraw → edit → resubmit timeline.
- A raw-SQL illegal status change is rejected. A raw-SQL delete of a non-draft order is
  rejected.
- PO numbers:
  - unique under 50 concurrent creates
  - no reuse after a delete
  - `poNumber` in any body → 400
  - a raw-SQL change of `po_number` is rejected
  - FY boundary: 31 March 23:59:59 IST → `2025-26`, 1 April 00:00 IST → `2026-27`, the
    new FY starting at `000001`, using an injected database clock
  - format regex `^PO-\d{4}-\d{2}-\d{6,}$`
