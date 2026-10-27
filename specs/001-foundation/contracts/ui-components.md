# UI Component Contracts — Slice 0

Shared building blocks every later slice uses. Behaviour comes from ADR-0018. These are
contracts (props and behaviour), not implementations.

## ConfirmDialog

| Prop | Type | Rule |
|---|---|---|
| `title` | string | names the action and the object, e.g. "Cancel order PO-2026-27-000123?" |
| `children` | node | the consequence in plain words, plus key facts |
| `confirmLabel` | string | the action, e.g. "Cancel order". Never "OK" or "Yes" (a lint rule checks literals) |
| `cancelLabel` | string, default "Go back" | the safe button, e.g. "Keep editing" for the unsaved-changes guard |
| `tone` | `'default' \| 'danger'` | danger styling for destructive actions |
| `reason` | `{ label, minLength, maxLength } \| undefined` | when set, a reason field is shown and confirm stays disabled until it's valid |
| `onConfirm` | `(reason?: string) => Promise<void>` | while pending, confirm and the error actions are disabled and confirm shows progress; a rejection is caught and shown inside the dialog, which stays open |
| `onClose` | `() => void` | Escape, the safe button and clicking outside all call it, except while pending |
| `error` | `ProblemLike \| undefined` | shown inside the dialog with its mapped message and next step |
| `errorActions` | e.g. `[{ label: 'Reload order', onPress }]` | extra actions for an error, such as a version conflict |

Behaviour:
- `role="alertdialog"`, labelled by the title and described by the body.
- Focus starts on the safe (cancel) button, is trapped while open, and returns to the
  trigger on close.
- A double click on confirm results in exactly one `onConfirm` call.
- The caller passes one `Idempotency-Key` per dialog session where the endpoint takes one,
  and reuses it on retry.

## Page states

| Component | Shows |
|---|---|
| `<Loading label>` | an accessible busy indicator (`aria-busy`, `role="status"`) |
| `<Empty title description action?>` | what's missing and, optionally, the next step |
| `<ErrorState problem onRetry?>` | the mapped message for `problem.code`, the `correlationId` as "Request ID", and **Retry** only for `503`-class codes |
| `<RouteErrorBoundary>` | catches render errors in one route, shows `ErrorState` with the failing request's own id (none for an error no request caused), and keeps the shell (navigation) working; a page whose code can't be loaded (an open tab after a deploy) shows "A newer version of the app is available" with **Reload** |

`useQueryStates(query, options)` renders the right state for a TanStack Query result, so
pages don't hand-roll them. It returns `{ view, data, notice }`: `view` (loading, error,
empty, or the `idle` content for a query that isn't enabled yet) when there is nothing to
show, otherwise `data` plus `notice`, which is set when a background refresh failed: the
loaded data stays on screen with the error above it. A network failure counts as a
temporary failure (Retry, and automatic retries); errors show their own request's id.

## useUnsavedChangesGuard(isDirty: boolean) → { dialog, release }

- In-app navigation while dirty opens a ConfirmDialog: "Discard your unsaved changes?",
  confirm label "Discard changes", danger tone. It's built on React Router's `useBlocker`.
- A reload or tab close while dirty triggers `beforeunload`, which shows the browser's own
  prompt.
- Nothing happens when not dirty, and the guard is released after a successful save. A
  save that navigates in the same handler calls `release()` first, since the guard sees the
  cleared flag only after a re-render. If the page turns clean while the dialog is open, it
  closes and the page stays.
- Render `dialog`.

## Error message map

`errorMessages: Record<ErrorCode, { message, action? }>` in `frontend/src/errors/`.
A test fails if any registry code has no entry, which happens automatically when a slice
adds a code.

## Development-only demo route

`/__demo`, present only in development builds, renders each component in every state for
the component tests and the axe checks. A build test asserts the production bundle contains
no `__demo` route.
