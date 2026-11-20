# UI: Slice 5 — Cancel (ADR-0018)

## Order detail (`frontend/src/pages/orders/OrderDetail.tsx`)

- **Cancel order** button: shown when the caller holds APPROVER, isn't the owner, and the
  order is `APPROVED`. Not shown to Admins, pure Buyers or the owner.
- **Cancellation** section (`role="region"`, name "Cancellation") on a cancelled order:
  "Cancelled by {name} on {formatDateTime(cancelledAt)}" and the reason. The status badge
  reads Cancelled. No action buttons.
- **Owner-can't-act marker** on an `APPROVED` order with `ownerCanAct: false` (spec
  FR-017a): everyone who can read it sees "Its owner can no longer act on it, so receipts
  can't be recorded."; an Approver who may cancel it also sees "To close it, cancel it,
  and a buyer can raise a new order if the goods are still needed." Same visual pattern
  as the pending marker.
- The approval panel is unchanged on a cancelled order (round and steps as decided).

## Cancel dialog (`frontend/src/pages/orders/CancelDialog.tsx`)

ConfirmDialog, `alertdialog`:
- Title "Cancel PO-…?"; names the buyer, vendor and total.
- "Nothing has been received against this order." (slice 6 adds the per-line summary).
- "Cancelling is final. No further goods can be received against this order."
- Reason field: label "Reason", required, 500 characters, counter; empty or whitespace →
  "Enter a reason." at the field; a server `TOO_SHORT` / `TOO_LONG` shown at the field.
- Buttons: "Keep order" (initial focus, the safe choice) and "Cancel order".
- `VERSION_CONFLICT`, `INVALID_STATE_TRANSITION`, `NOT_FOUND` → the message and "Reload
  order" (`reloadOrderAction`); `SELF_APPROVAL`, `FORBIDDEN`, `ACCOUNT_DEACTIVATED` → their
  messages by `code`.
- On success: dialog closes, the order is refetched, the Cancellation section shows.

## Editor and lists

- Saving an editor open on an order cancelled meanwhile → `ORDER_LOCKED` with
  `orderState.status = 'CANCELLED'` → "This order was cancelled and is closed."
- Order list status filter offers Cancelled (already in `ORDER_STATUSES`; a test pins it).

## Accessibility

axe on the dialog (open, with a field error) and on a cancelled order's page; focus
returns to the Cancel order button on Keep, to the page heading on success.
