# ADR-0018: Production-grade frontend

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (account pages, profile, admin
  users, pending count; Access pending screen and access requests; confirmation dialogs;
  unsaved-changes guard) · component library choice deferred to the slice-0 plan
- **Brief:** stack (React frontend), §6
- **Principles:** XIII, VI, VII, IX

## Decision

### Foundation
- **Stack**: React + TypeScript `strict`, Vite, React Router (data router, for navigation
  blocking), TanStack Query.
  - The client and types are generated from the committed OpenAPI (ADR-0008).
  - Forms use the shared Zod schemas.
  - There is exactly one component library, chosen in the slice-0 plan by accessibility
    support and virtualised-table fit.
- **Auth flow**:
  - A `401` from any request triggers one refresh. The refresh is single-flight within a
    tab, and coordinated across tabs (BroadcastChannel / Web Locks) so only one tab
    refreshes.
  - Queued requests then retry. A failed refresh → `/login?returnTo=…`.
  - The CSRF token is read from its cookie and sent as `X-CSRF-Token`.
  - Role-based routes only hide what the user can't use.
  - A user with no role is routed to the Access pending screen. A `403 NO_ROLE_ASSIGNED`
    from any request does the same.
- **Errors**:
  - One mapping from `code` to user messages and actions.
  - `VERSION_CONFLICT` offers a reload of the latest version. `503` offers a retry.
  - Error boundaries wrap each route, and error screens show the `requestId`.
- **Money**: a branded `DecimalString` type, with lint banning arithmetic or `Number()` on
  it. Formatted with `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR',
  minimumFractionDigits: 2, maximumFractionDigits: 4 })`.
- **Lists**: page numbers matching the API envelope. Filters, sort and page are kept in the
  URL query, so views are shareable and survive a reload. Search is debounced (300 ms).
- **UX safety**:
  - Every view has loading, empty and error states.
  - Submit buttons are disabled while a request is pending.
  - A UUID `Idempotency-Key` is generated per create attempt and reused on retry.
- **500-line order editor**: a virtualised table with row-level validation from the Zod
  schema. The array order is the line order (ADR-0009).
- **Accessibility and security**:
  - WCAG 2.1 AA, with axe in the component and end-to-end tests.
  - CSP `default-src 'self'` with no inline scripts (served by nginx).
  - Lint bans `dangerouslySetInnerHTML`. All user-supplied text (access-request messages,
    notes, reasons) renders as text.
  - Dependency audit in CI.
- **Performance**: route-level code splitting. Budgets and editor targets are in ADR-0012.

### Confirmation dialogs
**Rule: confirm any action that can't be undone, ends something, or changes what another
person can do.** Reversible saves are **not** confirmed: saving a draft, editing the
profile, editing vendor details, reactivating a vendor. People who see too many dialogs
learn to click "OK" without reading, so each dialog has to be worth reading.

Dialogs are a frontend safeguard. They rely on `GET /api/approval-policy` (ADR-0002) and
the multi-line receipt command (ADR-0011). The server enforces every rule regardless.

**One shared `ConfirmDialog` component:**
- **Wording**:
  - The title names the action and the object ("Cancel order PO-2026-27-000123?").
  - The body states the consequence in plain words, plus the key facts.
  - The confirm button is labelled with the action ("Cancel order"), never "OK" or "Yes".
    Destructive actions use the danger style.
- **Focus and closing**:
  - Initial focus goes to the safe button, not the confirm button.
  - Escape, the safe button and clicking outside all close the dialog.
- **Accessibility**: `role="alertdialog"`, labelled and described by its title and body,
  focus trapped inside, and returned to the trigger afterwards.
- **Reasons**: when a reason is required, the field is inside the dialog, and confirm is
  disabled until the reason is valid.
- **While the request runs**: confirm is disabled and shows progress, so a double click
  can't send twice. A retry reuses the same `Idempotency-Key` where the endpoint takes one.
- **Server errors** (`409 VERSION_CONFLICT`, `ORDER_FULLY_RECEIVED`, …) are shown **inside**
  the dialog, with what to do next. A conflict offers "Reload order".

**Where (dialog content in brackets):**

Buyer:
- **Submit order** [the saved total; "Will be auto-approved" or "Will go to the Approver
  for approval", worked out from `GET /api/approval-policy`; "You can't edit it after
  submitting; you can withdraw it while it's pending". The dialog says the outcome is
  *expected*: the server's result is what counts, and the page shows the actual outcome
  afterwards.]
- **Withdraw pending order** [required reason; "It returns to Draft, and approval starts
  again when you resubmit"]
- **Delete draft** [PO number, vendor, line count, total; "This permanently deletes the
  draft"]
- **Record receipt** [for each line in the command: receiving N, received so far R,
  outstanding after M. When a line becomes fully received: "This marks line X as fully
  received. Receipts can't be changed or undone."]
- **Deactivate vendor** [how many of the caller's draft orders use it; "Orders using it
  can't be submitted or approved until it's reactivated"]
- Reactivate vendor: no dialog, because it's reversible.

Approver:
- **Approve** [PO number, buyer, vendor, total; "The buyer can then receive goods; the
  order can't be edited"]
- **Reject** [required reason; "Rejection is final; the buyer must raise a new order"]
- **Cancel approved order** [required reason; per-line ordered and received, summarised
  as, for example, "2 of 5 lines partly received"; "Cancelling is final; no further
  receipts can be recorded"]

Admin:
- **Change role** [old → new role set; the user's open-order counts; "Their sessions will
  end and they'll need to log in again"]
  - Assigning a first role to a no-role user also says it resolves their access request.
  - Assigning Buyer + Approver to the only Approver warns that their own orders above the
    threshold can't be approved (ADR-0002).
- **Deactivate user** [open-order counts; "They'll be logged out everywhere and can't log
  in"]
- **Reactivate user** [a short confirm]
- **Send password reset** [the user's email; "Their current password keeps working until
  they complete the reset"]
- **Dismiss access request** [an optional note, shown to the user]

Everyone:
- **Log out everywhere** ["Every device, including this one, will be logged out"]
- **Revoke a session** [device, last used. Revoking the current session says it logs you
  out.]
- **Change password** ["Your other sessions will be logged out"]
- **Leaving a page with unsaved edits** (draft order form, profile, vendor form) ["Discard
  your unsaved changes?"]. It uses the router's navigation blocker for in-app navigation,
  and `beforeunload` for reloads and tab closes. The browser shows its own text there.

### Screens
- **Account pages** (public): signup, verify-email, forgot-password and reset-password.
  - Each shows the same neutral confirmation whatever the outcome ("if an account exists,
    we've sent an email").
  - Password fields show the policy, and field errors come from the API field codes.
  - Pages that receive a token post it once and then remove it from the URL (history
    replace).
- **Access pending** (verified user with no role):
  - "Your account is active, but an administrator hasn't assigned you a role yet. You
    can't raise or approve orders until then."
  - Shows the date they signed up.
  - A "Message the administrator" form (plain text, 1–500 characters). Once sent, the
    screen shows "Request sent on …". It shows the admin's note if the request was
    dismissed, and the user can send another.
  - Links to profile and logout. After a role is assigned, the user's session ends and the
    next login lands on the role's home screen.
- **Profile** (`/profile`, every user, with or without a role):
  - edit name and phone
  - email, roles and status shown read-only
  - a change-password form
  - active sessions (device from user agent, IP, last used, "this device"), with
    revoke-one and log-out-everywhere
- **Admin Users screen**:
  - a paginated list with role (including "No role"), status and name/email search filters
    held in the URL
  - a role dropdown (Buyer / Approver / Buyer + Approver)
  - deactivate and reactivate; send a reset email
  - Admin rows are read-only, and the admin's own row offers no actions.
  - An **Access requests** tab: a paginated list with a status filter, showing the user,
    message, dates and actions "Assign role" (opens the role dialog) and "Dismiss".
- **Nav**:
  - Approvers see a pending-approvals count, read from the approver queue's `total` with
    `pageSize=1`.
  - Admins see an open access-request count badge on Users (`status=OPEN&pageSize=1`).
  - Both refresh every 60 s, on window focus and after each related action.
- **All screens**: login, signup, verify-email, forgot-password, reset-password, access
  pending, profile, my orders, order editor, order detail with audit timeline, approver
  queue, vendors, outstanding report, admin audit log, admin users (with access requests).

## Tests
- Vitest + Testing Library for units and components, with MSW handlers generated from the
  OpenAPI.
- **ConfirmDialog**:
  - a component test per dialog: content and facts, initial focus on the safe button,
    Escape and outside-click close, confirm disabled while pending (a double click sends
    one request), reason validation, server error shown inside with its next step
  - axe on every dialog
  - no dialog on the reversible saves listed above
- Playwright against the docker compose stack:
  - login and silent refresh (an expired access token is refreshed transparently)
  - create → submit (dialog shows the expected outcome) → approve → partial receipt
  - receipt that fully receives a line (dialog shows the fully-received wording)
  - cancel with reason
  - delete draft
  - editing a locked order shows the `ORDER_LOCKED` message
  - 404/403 visibility between buyers and roles
  - `VERSION_CONFLICT` reload prompt inside a dialog
  - logout and logout-all
  - signup → verification email (via Mailpit) → verify → login → Access pending → send an
    access request → admin assigns a role from the request → user logs in to the Buyer home
  - an admin dismisses a request with a note, and the user sees it
  - forgot-password → reset email → reset → old sessions logged out
  - profile edit, change password, revoke another session (that session is sent to login on
    its next refresh)
  - an admin changes a user's role (that user is sent to login, and the new role applies
    afterwards) and deactivates a user
  - unsaved-changes guard on the draft form (in-app navigation blocked; confirm discards)
  - the pending-approvals count and the access-request badge update after an action
- axe checks on every screen. A bundle-budget check. The editor interaction benchmark.
