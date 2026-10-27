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
| `onConfirm` | `(reason?: string) => Promise<void>` | while pending, confirm is disabled and shows progress |
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
| `<RouteErrorBoundary>` | catches render errors in one route, shows `ErrorState` with the failing request's own id (none for an error no request caused), and keeps the shell (navigation) working |

`useQueryStates(query)` renders the right state for a TanStack Query result, so pages don't
hand-roll the three states.

## useUnsavedChangesGuard(isDirty: boolean)

- In-app navigation while dirty opens a ConfirmDialog: "Discard your unsaved changes?",
  confirm label "Discard changes", danger tone. It's built on React Router's `useBlocker`.
- A reload or tab close while dirty triggers `beforeunload`, which shows the browser's own
  prompt.
- Nothing happens when not dirty, and the guard is released after a successful save.

## Error message map

`errorMessages: Record<ErrorCode, { message, action? }>` in `frontend/src/errors/`.
A test fails if any registry code has no entry, which happens automatically when a slice
adds a code.

## Development-only demo route

`/__demo`, present only in development builds, renders each component in every state for
the component tests and the axe checks. A build test asserts the production bundle contains
no `__demo` route.
