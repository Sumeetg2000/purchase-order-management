# UI contract: Slice 6 — Goods receipt

## Order detail (`frontend/src/pages/orders/OrderDetail.tsx`)

- Line table: Ordered, Received, Outstanding columns on every non-draft order.
- Status area: the receipt badge (approved: "Partly received" / "Fully received";
  cancelled with receipts: "Cancelled · partly received"); the cancelled summary line
  "Cancelled · 2 of 5 lines complete, 1 partly received".
- `ReceiptsSection.tsx`: the history (receipt date, line, quantity, note, recorded by,
  recorded at), newest first, paginated; empty state "No goods received yet."
- Actions: "Record receipt" for the owner of an `APPROVED` order with
  `receiptProgress ≠ FULLY_RECEIVED`. Cancel and the owner-can't-act marker hidden when
  fully received.

## Record receipt (`ReceiptForm.tsx`, `ReceiptDialog.tsx`)

- Form: one row per line with outstanding > 0 (position, description, outstanding, a
  quantity input, blank = not in this delivery); receipt date (default today in India
  time, `min` the approval date, `max` today); note (0–500). Inline field errors by
  field code. At least one quantity needed to continue.
- Dialog (shared `ConfirmDialog`): title "Record receipt for {PO number}"; per line
  "Line {n}: receiving {N}, received so far {R}, outstanding after {M}"; for each line
  reaching 0: "This marks line {n} as fully received. Receipts can't be changed or
  undone."; safe choice ("Go back") focused; confirm disabled while pending; one
  `Idempotency-Key` per opening, reused on retry; server errors inside with Reload order; `RECEIPT_EXCEEDS_OUTSTANDING` lists every
  offending line, and the form marks each one's quantity input.
- After success: the order and its receipts reload; a status message "Receipt recorded."

## Cancel dialog (`CancelDialog.tsx`, changed)

- Per line ordered and received; the summary (research R8) in place of "Nothing
  received" when something was; `ORDER_FULLY_RECEIVED` shown inside with Reload order.

## Lists

- Every order list (`OrdersList.tsx` and its scopes) shows the badge after the status.
  No new filter. The approval queue is unchanged.

## Admin (`pages/admin/RoleDialog.tsx`, `UserDialogs.tsx` `ActivationDialog`)

- The web app has no user detail page (the Admin works from the user list and its
  dialogs), and this slice adds none: the change-role and deactivate dialogs load `GET
  /api/admin/users/{id}` when opened (a loading state, then the counts) and show "{draft}
  drafts · {pending} pending · {approvedWithOpenLines} approved with goods to receive",
  and when any is above zero:
  "An Approver rejects their pending orders and cancels their approved ones; a buyer
  raises new orders if still needed."

## Accessibility

- axe on the order page with receipts, the receipt form and dialog, the cancel dialog
  with receipts, the two admin dialogs with counts; quantity inputs labelled per line; badges are text,
  not colour alone.
