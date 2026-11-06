# UI contract: Slice 2 — Vendors

ADR-0018 rules apply: generated client, errors by `code`, loading/empty/error states,
WCAG 2.1 AA, no double submit, strict CSP. Nav item "Vendors" for every role holder.

| Route | Who | Content |
|---|---|---|
| `/vendors` | all roles | Table: name, contact, payment terms (e.g. "Net 30", "Advance", "30 % advance, balance net 45"), status. Filters in URL: status (Active default / Inactive / All), name prefix search (debounced). Pagination. "Add vendor" button for Buyers. Empty state names the active filter. |
| `/vendors/new` | Buyer | `VendorForm`. Payment terms: type radio group; fields shown for the chosen type only. Save → detail page. No confirmation. |
| `/vendors/:id` | all roles | Details, status badge. Buyers: Edit, Deactivate (dialog) or Reactivate (no dialog). Tabs: Details, History (Buyers and Admins). |
| `/vendors/:id/edit` | Buyer | `VendorForm` prefilled; sends `If-Match`. Clearing the phone field sends `null`. |

Behaviour:
- **Deactivate dialog** (`ConfirmDialog`): title "Deactivate {name}?", body "Orders using
  it can't be submitted or approved until it's reactivated." Safe button ("Keep active")
  focused; confirm disabled while pending. The caller's draft count joins in slice 3.
- **Unsaved changes**: leaving a dirty `VendorForm` asks "Discard your unsaved changes?"
  (router blocker and `beforeunload`).
- **`DUPLICATE_VENDOR_NAME`**: error on the name field with a link to
  `/vendors/{existingVendor.id}`.
- **`VERSION_CONFLICT`** / **`INVALID_STATE_TRANSITION`**: message with "Reload", which
  refetches and discards the form only after the unsaved-changes prompt.
- **History**: newest first, paginated; each row: when, who (name, email, role), action,
  and the changed fields as before → after.
- Approvers and Admins see no write controls; a Buyer-only route opened by them shows the
  Forbidden page.

Tests: component tests per screen and dialog (states, field errors by code, a11y with
vitest-axe); Playwright `vendors.spec.ts`: two Buyers share a vendor; duplicate link;
version conflict and reload; deactivate via dialog and reactivate; Approver read-only.
