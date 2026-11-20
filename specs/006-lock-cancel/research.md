# Research: Slice 5 — Cancel approved orders, and the remaining locks

Decisions for `specs/006-lock-cancel`. Owner steer (2026-11-20) is marked **[steer]**;
owner sign-offs are listed in R10.

## R1 Where the cancel record lives [steer]

- **Decision**: three columns on `purchase_orders`: `cancelled_by uuid` (FK `users`),
  `cancelled_at timestamptz`, `cancel_reason text`. One CHECK ties them to the status:
  all three set iff `status = 'CANCELLED'`. A second CHECK applies the reason rule
  (ADR-0007, as `approval_rounds_withdraw_reason_valid`: trimmed, 1–500 characters,
  line breaks allowed). `cancelled_at` is set by the database clock in the guard (R2), never by
  the caller.
- **Rationale**: one cancel per order, final; the order read and the list need it
  without a join; the CHECK makes a `CANCELLED` row without its record impossible
  (spec US3 scenario 4 refused "before commit").
- **Alternatives**: a `order_cancellations` table (a join on every read for a 1:1 row);
  only the audit entry (the order read would have to search the audit trail, and the
  database couldn't require the record).

## R2 What the database refuses (rules D9–D11, extending slice 4's D1–D8)

Existing rules already lock most of a cancelled order; this slice adds what is missing.

| Part | Refused today by | Added |
|---|---|---|
| Lines (insert, update, delete) | `PO006` (drafts only) | — |
| Order deletion | `PO010` (drafts only) | — |
| Vendor, `current_round`, `submitted_at`, `approved_at` | `PO015` (unless status changes); `PO014` at commit | D10 freezes them on the cancel transition itself |
| Closed round, its vendor snapshot | `PO013` (a round closes once) | — |
| Steps | `PO012` (only on a pending order's open round) | — |
| Status | `PO009` (transitions table) | row `APPROVED → CANCELLED` |
| `po_number`, `owner_id`, `created_at` | `PO008` | — |
| Derived columns | `PO005` | — |
| Every other column of a cancelled or rejected order (`version`, cancel columns, …) | nothing | **D9** |
| Cancel columns set outside the cancel, by the wrong actor | nothing | **D10**, **D11** |
| `CANCELLED` without matching round state | `PO014` returns "not reachable yet" | **D1 extended** |

- **D9 `PO018 ORDER_CLOSED`**: no `UPDATE` of a row whose `OLD.status` is `CANCELLED` or
  `REJECTED` (both final), whatever the column, `version` included. (`DELETE` is already
  `PO010`.) Signed off 2026-11-20 (R10 Q4).
- **D10 `PO019 ORDER_CANCEL_REFUSED`**: the cancel columns change only on the
  `APPROVED → CANCELLED` update; on that update nothing changes except `status`,
  `version` (+1), `updated_at` and the three cancel columns; the guard sets
  `cancelled_at := now()`.
- **D11 (`PO016 SELF_DECISION_REFUSED`, reused)**: on that update `app.actor_type` is
  `USER`, `cancelled_by` is the acting user, and never the owner. Same rule and code as a
  step decision.
- **D1 extended**: `approval_inconsistency` gains a `CANCELLED` branch: the current
  round is closed `AUTO_APPROVED` (no steps) or `APPROVED` (every step approved),
  `approved_at` is the round's close, and the cancel columns are set (the CHECK already
  guarantees the last). Reconciliation picks this up unchanged.
- Two new SQLSTATEs, mapped once in `db/errors.ts`; both are attack-only (the service
  refuses first with an API code).
- **Alternatives**: one code for D9 and D10 (attack tests couldn't tell which rule
  fired).

## R3 Lock order and checks for cancel [steer: ADR-0006; Approver re-checked as in approve]

- **Decision**: order `FOR UPDATE` → the acting Approver's `users` row `FOR SHARE`.
  - No line locks: every line change locks its order first (as submit relies on), so the
    per-line ordered and received quantities read for `PO_CANCELLED` can't move under
    the order lock. **Slice 6 constraint**: a receipt must lock the order first too,
    which ADR-0006's order → lines rule already says.
  - No round or step locks: a closed round and its steps never change (`PO012`, `PO013`).
  - No vendor lock and no owner lock: cancel is allowed whatever their status (FR-004,
    FR-005), so nothing is decided on them.
  - Then the `FOR KEY SHARE` of `cancelled_by`'s foreign key, on the row already held.
- **Checks, in ADR-0004 precedence** (route-level role checks run before, see R5):
  Approver re-checked under lock (`401 ACCOUNT_DEACTIVATED`, `403 FORBIDDEN`) → `404`
  unless readable → `403 SELF_APPROVAL` if owner → `409 INVALID_STATE_TRANSITION` unless
  `APPROVED` → `409 VERSION_CONFLICT`.
- **Rationale**: the fewest locks that still decide only on locked rows; `users` last.
- **Alternatives**: approve's full set (steps, vendor, owner): extra locks for facts the
  decision doesn't read, and more deadlock surface.

## R4 Races tested (US5, SC-003: each 10 times, barriers, business outcome asserted)

1. Cancel vs cancel (same version): one `CANCELLED`, one `PO_CANCELLED`; the other
   `409 VERSION_CONFLICT` or `INVALID_STATE_TRANSITION`.
2. Cancel vs the acting Approver's deactivation, and vs their APPROVER removal, each
   started in either order: cancelled before the change, or `401` / `403` after it, never
   cancelled after it; no deadlock.
3. Cancel vs the vendor's deactivation: both succeed; no deadlock.
4. Cancel vs the owner's deactivation or BUYER removal: both succeed; no deadlock.
5. Cancel vs the owner's edit or delete of the (approved) order: the edit or delete gets
   `ORDER_LOCKED` either way; the message names whichever status it saw.

Cancel vs receive is slice 6 (spec Assumptions).

## R5 API shape and authorization

- **Decision**: `POST /api/orders/:id/cancel`, `If-Match` required, body
  `decisionReasonBody` reused (`{ reason }`, strict; empty or whitespace-only →
  `TOO_SHORT`, over 500 → `TOO_LONG`); `200` with the order and its new `ETag`. Operation
  `cancelOrder`: `access: 'role'`, `roles: [APPROVER]`, `forbiddenDetail`:
  `{ ADMIN: ORDER_ADMIN_READ_ONLY_MESSAGE, BUYER: ORDER_CANCEL_APPROVER_ONLY_MESSAGE }`
  ("Only Approvers can cancel orders.", signed off 2026-11-20). Errors:
  `ACCOUNT_DEACTIVATED`, `NOT_FOUND`, `SELF_APPROVAL`, `INVALID_STATE_TRANSITION`,
  `VERSION_CONFLICT`, plus the standard set. No new registry code.
- `ORDER_ACTIONS` gains `CANCEL`, so `INVALID_STATE_TRANSITION`'s `orderState.action`
  names it.
- `ORDER_LOCKED_MESSAGES.CANCELLED`: "This order was cancelled and is closed." (spec
  FR-010). Edit and delete of a cancelled order take it with no other change.
- **SELF_APPROVAL detail on cancel signed off, R10 Q2**: today one constant, "You can't
  approve or reject an order you raised." Proposed: a per-action detail, cancel's being
  "You can't cancel an order you raised."
- **Where it lives**: `approvals/` (routes → service → repository), beside approve and
  reject, sharing `lockUsers` and the Approver re-check; `orders/` gains only the lock
  message and the read fields.

## R6 Order read: the cancel record and the marker

- **Decision**: the order read gains `cancellation: { cancelledBy: { id, name },
  cancelledAt, reason } | null`, for everyone who can read the order (spec FR-003). The
  name is the user's current name, as deciders' names are (ADR-0004 S6); the audit entry
  keeps the snapshot. Order list items are unchanged (status only).
- The owner-can't-act marker (spec FR-017a) needs no API change: `ownerCanAct` is already
  on every order read. (signed off, R10 Q3) extends ADR-0004 S5's marker from pending
  orders to approved ones, with the two sentences signed off in the spec.

## R7 Audit: `PO_CANCELLED`

- **Decision**: actor `USER`, acting role `APPROVER`; `details`: `round`, `reason`,
  `lines: [{ lineId, position, quantity, receivedQuantity }]` in position order (ADR-0016's
  "per line ordered and received"; the round as every slice 4 approval payload carries
  it). Written in the cancel's transaction. `received` is 0 on every line in this slice.
- ADR-0016's row gains the field names (an ADR update, no new event).

## R8 Performance [steer: no new index unless a plan test fails]

- **Decision**: no new index. The Cancelled filter is `status = 'CANCELLED'`, served by
  the existing `purchase_orders_status_created_idx` (Admin, and the Approver's non-draft
  scope, which `status = 'CANCELLED'` implies), `purchase_orders_owner_status_created_idx`
  (Buyer) and the vendor/status indexes. The plan suite gains `status=CANCELLED` and
  `status=CANCELLED + vendor` cases for all four scopes, page 1 (and the deep page where
  the slice 4 rule takes one), plus counts; they must stop at the page. An index is added
  only if one of them fails, and then shown to the owner first.
- `cancelled_by`'s foreign key gets a partial index `WHERE cancelled_by IS NOT NULL`,
  like `approval_steps_decided_by_idx`, so a `users` key change never scans orders. This
  is a foreign-key index, not a filter index (signed off, R10 Q5).
- **Dataset [SIGN-OFF, R10 Q6]**: ADR-0012's mix splits approved orders: 1,000
  `CANCELLED` out of the 90,000 `APPROVED` (so 89,000 approved), each with its cancel
  columns and an approved round.
- **Timings**: FR-019 first (submit and approve: 50 timed runs after 3 warm-up, targets
  unchanged), then cancel at `DECISION_P95_MS` (150 ms), same 50/3.

- **T001 results (2026-11-20, local, 50 timed runs after 3 warm-up)**: p95 create 76 ms,
  replace 124 ms, busiest Buyer's page 11 ms, submit 47 ms, approve 41 ms, queue page
  11 ms; all within their targets.
- **T031 results (2026-11-20, local)**: cancel of a 500-line order p95 34 ms (target
  150 ms), measured in the same 50 runs as submit (42 ms) and approve (37 ms).

## R9 Web app

- `CancelDialog` (ConfirmDialog, ADR-0018): names the PO number, buyer, vendor and total;
  "Nothing has been received." in this slice (per-line display arrives with receipts);
  reason field (required, 500, "Enter a reason."); says "Cancelling is final. No further
  goods can be received against this order."; focus starts on "Keep order"; confirm
  button "Cancel order"; offers Reload order via `reloadOrderAction`.
- Order detail: Cancel order button for an Approver, not the owner, on `APPROVED`; the
  Cancellation section ("Cancelled by {name} on {date}: {reason}"); the owner-can't-act
  marker on approved orders, with the two sentences; no action on a cancelled order.
- The list's status filter already offers Cancelled (`ORDER_STATUSES`); a test pins it.
- Errors by `code`: `ORDER_LOCKED` with `orderState.status = 'CANCELLED'` shows the
  cancelled message in the editor (spec US3 scenario 5).

## R10 Sign-off (owner, 2026-11-20: all signed off as proposed)

1. ADR-0004 cancel row: signed off with the spec and written.
2. `SELF_APPROVAL` detail by action: cancel "You can't cancel an order you raised."; the
   code stays `SELF_APPROVAL`.
3. ADR-0004 S5 extended: the owner-can't-act marker on approved orders, with the
   clarified wording.
4. D9 covers `REJECTED` as well as `CANCELLED`: nothing changes, `version` included.
5. The partial foreign-key index on `cancelled_by`.
6. ADR-0012: 1,000 of the 90,000 approved orders cancelled.
7. The canceller's name readable by everyone who can read the order.

ADR updates written 2026-11-20: ADR-0001, ADR-0004, ADR-0006, ADR-0012, ADR-0016.
