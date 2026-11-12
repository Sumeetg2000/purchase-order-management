# UI contract: Slice 3 — Draft orders

ADR-0018 rules apply throughout: generated client, errors by `code`, loading/empty/error
states, no double submit, CSS Modules, axe on every screen.

## Routes (`frontend/src/pages/orders/`)

| Route | Who | Shows |
|---|---|---|
| `/orders` | Buyer, Approver, Admin | List: PO number, vendor, status, lines, total (en-IN INR), created; filters status, vendor (combo box over the vendor list), PO-number prefix (debounced), created from/to; page numbers; all in the URL. With a PO-number prefix the list is sorted by PO number (newest number first) and says so above the table. Buyers: "New order". Approvers: empty state "Orders appear here once buyers submit them." |
| `/orders/new` | Buyer | Editor (below), vendor picker limited to active vendors |
| `/orders/:id` | Readable callers | Header (PO number, status, vendor with an "Inactive" badge when so, owner, total), lines table, Timeline tab. Owner of a draft: "Edit" and "Delete draft" |
| `/orders/:id/edit` | Owner of a draft | Editor with the stored order |

## Editor

- Virtualised line table (TanStack Virtual); columns description, quantity, unit price,
  line total (computed live with `money.ts`), remove; "Add line"; move up/down; keyboard
  reachable.
- Row-level validation from `createOrderBody`/`editOrderBody` lines, shown inline; the
  total updates as the user types; save disabled while invalid or pending.
- Save: no confirmation (reversible). Create sends a fresh `Idempotency-Key` per attempt,
  reused on retry. Edit sends `If-Match`.
- Unsaved-changes guard: "Discard your unsaved changes?" on in-app navigation and
  `beforeunload`.
- `409 VERSION_CONFLICT`: inline banner "This order changed since you opened it." with
  "Reload order" (discarding local edits after the guard).
- `409 VENDOR_INACTIVE`: banner naming the vendor, focus to the vendor picker.
- Targets (ADR-0012): keystroke → paint p95 ≤ 50 ms, add/remove line ≤ 100 ms, a loaded
  500-line order interactive ≤ 1,000 ms (4× CPU throttling).

## Dialogs (shared `ConfirmDialog`)

- **Delete draft**: title "Delete draft PO-2026-27-000123?"; facts: vendor, line count,
  total; text "This permanently deletes the draft." and "You won't be able to see this
  draft or its history again."; optional reason (≤ 500); confirm "Delete draft"; safe
  choice focused. Errors shown inside the dialog; `VERSION_CONFLICT` offers "Reload order".
- **Deactivate vendor** (slice 2 dialog, amended): adds "N of your draft orders use this
  vendor" from `GET /orders?vendorId=…&status=DRAFT&pageSize=1` → `total` (omitted when
  0; "Couldn't load your draft count" on error, without blocking the action).

## Messages (`frontend/src/errors/messages.ts`)

`IDEMPOTENCY_KEY_REUSED` added; `FORBIDDEN` on an order write shows
`ORDER_ADMIN_READ_ONLY_MESSAGE` when the signed-in user is an Admin; field codes `LINE_NOT_FOUND`, `DUPLICATE_LINE_ID`,
`READ_ONLY_FIELD` mapped.
