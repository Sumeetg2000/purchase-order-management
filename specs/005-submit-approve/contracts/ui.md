# UI contract: Slice 4 — Submission, routing, approval, rejection and withdrawal

ADR-0018 rules apply throughout (generated client, errors by `code`, loading/empty/error
states, no double submit, `ConfirmDialog`, axe on every screen). Research R11.

## Routes

| Route | Who | Change |
|---|---|---|
| `/orders/:id` | readable callers | Non-draft: read-only; vendor from the snapshot (name, contacts, terms) with "as submitted"; **Approval** panel: round, policy version, each step (tier, threshold, state, decider, time, rejection reason), withdraw reason on a withdrawn draft. Actions: draft owner → Edit, Delete, **Submit**; pending owner → **Withdraw**; Approver not the owner, pending → **Approve**, **Reject**; when `ownerCanAct` is false the marker "Owner can no longer act on this order" and Reject only |
| `/orders/:id/edit` | owner of a draft | unchanged; never offered for a non-draft order |
| `/approvals` | Approver | **New.** Queue: PO number, buyer, vendor, total, step "1 of 1", submitted (relative and absolute), marker; oldest first; filters vendor and PO prefix in the URL; page numbers; empty state "No orders are waiting for your approval." |
| `/orders` | all | Approver empty state removed (the list now has non-draft orders) |

Nav: "Approvals" for Approvers, with the pending count (`GET /approvals?pageSize=1` →
`total`, hidden at 0), refreshed every 60 s, on focus and after submit, withdraw, approve
or reject.

## Dialogs (ADR-0018 text)

- **Submit order**: saved total; expected outcome from `GET /approval-policy` ("Will be
  auto-approved" at or below the lowest tier, else "Will go to the Approver for
  approval"), worded as expected; "You can't edit it after submitting; you can withdraw it
  while it's pending". After success the page states the actual outcome.
- **Withdraw pending order**: required reason (≤ 500); "It returns to Draft, and approval
  starts again when you resubmit".
- **Approve**: PO number, buyer, vendor, total; "The buyer can then receive goods; the
  order can't be edited".
- **Reject**: required reason (≤ 500); "Rejection is final; the buyer must raise a new
  order"; safe choice focused.
- Errors inside the dialog; `VERSION_CONFLICT` offers "Reload order";
  `ORDER_OWNER_INACTIVE` replaces Approve with Reject in place.

## Messages (`frontend/src/errors/messages.ts`)

The five registry codes of [errors.md](errors.md). `ORDER_LOCKED` chooses its sentence
from `details.status` (`ORDER_LOCKED_MESSAGES`); `ORDER_PENDING_APPROVAL` in the editor
offers "Withdraw" to the owner. `FORBIDDEN` on an order action shows the role's shared constant (ADR-0004,
2026-11-17): Admin `ORDER_ADMIN_READ_ONLY_MESSAGE`; pure Approver on an order write
`ORDER_APPROVER_READ_ONLY_MESSAGE`; pure Buyer on approve or reject
`ORDER_DECISION_APPROVER_ONLY_MESSAGE`. An approve or reject refused by the under-lock
re-check (`ACCOUNT_DEACTIVATED`, `FORBIDDEN`) is handled as the session-level code is
(ADR-0018).

## End-to-end (`frontend/e2e/approvals.spec.ts`)

create → submit ≤ threshold → auto-approved, Edit gone; create → submit > threshold →
Approver's queue and nav count → approve → `APPROVED`; submit → reject → `REJECTED`
message on a stale edit; submit → withdraw → edit → resubmit re-routes; a Buyer+Approver
doesn't see their own order in the queue and has no Approve on it.
