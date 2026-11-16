# ADR-0004: Private orders, visibility, separation of duties and the authorization matrix

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (matrix moved here from the
  constitution; no-role users and access requests; `DUPLICATE_APPROVER` removed; approval
  authority and owner transfer **not adopted**) · amended 2026-11-03 (POC scope, owner
  decision: no phone field, ADR-0016) · amended 2026-11-03 (**owner decision**: a route's
  access level is checked before validation, like `NO_ROLE_ASSIGNED`) · amended 2026-11-12
  (slice 3, **owner decision**: deleted-draft timelines, the Buyer+Approver order list,
  the Admin message on order writes)
- **Brief:** §2, §6 · Gaps G3, G18, G22, G24, Q3a, Q3b
- **Principles:** III, X

## Context
§2 lists what each role can do, but not which orders those actions apply to. The prototype
let any buyer edit any draft (lesson 3).

## Decision
- **Identity comes only from the verified token**, never from the body or query. Status and
  roles are loaded on every request (ADR-0017).
- **Deny by default**: every route declares its permission. A route without one fails a
  startup check and CI.
- **No role assigned**: a verified user with an empty role set can use only `GET`/`PATCH
  /me`, change password, their own sessions, logout and their own access request
  (ADR-0016). Every other authenticated endpoint → `403 NO_ROLE_ASSIGNED`.
- **Vendors are shared**: every Buyer reads and maintains all vendors. Approvers and Admins
  read them.
- **Orders are private to their creator**: a Buyer reads and acts only on their own orders,
  lines, receipts and audit entries.
- **Approver** reads `PENDING_APPROVAL`, `APPROVED`, `REJECTED` and `CANCELLED` across all
  buyers, never other buyers' drafts. They approve, reject and cancel any order except their
  own.
- **Procurement Admin** is read-only for orders, across all buyers and states, with no
  override (G18 rejected, because it would contradict §2). Their only write power is user
  management (ADR-0016).
- Every list and report is scoped to what the caller can read.
- `404` when the caller can't read the order. `403 NOT_ORDER_OWNER` when they can read it
  but the action is owner-only.
- **Receipts are owner-only.** Accepted trade-off: receipts wait if the owner is
  unavailable.
- **Separation of duties**: `SELF_APPROVAL` (`403`) means nobody approves, rejects or
  cancels an order they own, even when holding both roles.
  - `DUPLICATE_APPROVER` is removed (ADR-0002).
  - Approver ≠ receiver holds **by construction**: receipts are owner-only and nobody can
    self-approve.
  - Creator ≠ receiver is rejected, because with owner-only receipts nobody could ever
    receive.
- **Interpretation of §2:** §2 lists actions, not their scope. Ownership scoping is
  standard practice, so no sign-off is needed.
- **Approval authority levels: not adopted** (owner decision 2026-10-20). Any Approver
  decides any step.
- **Owner transfer / reassignment: not adopted** (owner decision 2026-10-20). Orders are
  never moved to another owner.
  - Reason: buyers clear their backlog before leaving.
  - Process for anything left open: the Approver rejects pending orders and cancels
    approved ones, and a new order is raised.
  - Accepted consequence: the vendor receives a new PO number for an order that was raised
    again.
- **Check precedence** (deterministic, so tests assert exact codes):
  1. `401`
  2. `403 NO_ROLE_ASSIGNED`: route-level, before validation, because the caller can't use
     the route whatever the input
  3. `403 FORBIDDEN` for the route's access level (amended 2026-11-03): also route-level and
     before validation, for the same reason. A Buyer on `/api/admin/*` gets `403`, never
     `400`, whatever the body.
  4. `400`: shape
  5. `404`: can't read
  6. `403` order-level: the role in context, ownership, separation of duties
  7. `409`: state, version, business rule
- Authorization is checked in the service layer against the order loaded **under lock** in
  the command's transaction.

## Authorization matrix
Every cell is tested, for each order state, and for unauthenticated callers. Changing a
cell changes a permission, so it needs sign-off (Principle X).

| Action | Owner Buyer | Other Buyer | Approver | Admin | No role |
|---|---|---|---|---|---|
| Read or maintain vendors | read and write | read and write | read | read | 403 `NO_ROLE_ASSIGNED` |
| Create order | ✓ | ✓ | 403 | 403 `FORBIDDEN`, "Admins can view orders but not change them." | 403 `NO_ROLE_ASSIGNED` |
| Read `DRAFT` order | ✓ | 404 | 404 | ✓ | 403 `NO_ROLE_ASSIGNED` |
| Read non-draft order | ✓ | 404 | ✓ | ✓ | 403 `NO_ROLE_ASSIGNED` |
| Edit, submit, withdraw, delete | ✓ (state rules apply) | 404 | 403 `NOT_ORDER_OWNER` (if readable) | 403 `FORBIDDEN`, "Admins can view orders but not change them." | 403 `NO_ROLE_ASSIGNED` |
| Approve or reject | 403 `SELF_APPROVAL` (if also Approver) | 404 | ✓ | 403 | 403 `NO_ROLE_ASSIGNED` |
| Cancel approved order | 403 `SELF_APPROVAL` (if also Approver) | 404 | ✓ | 403 | 403 `NO_ROLE_ASSIGNED` |
| Record receipt | ✓ | 404 | 403 `NOT_ORDER_OWNER` | 403 | 403 `NO_ROLE_ASSIGNED` |
| Outstanding report and order lists | own orders | — | readable orders | all | 403 `NO_ROLE_ASSIGNED` |
| Order audit timeline | own orders | 404 | readable orders | all | 403 `NO_ROLE_ASSIGNED` |
| Timeline of a deleted draft (by order id) | 404 (former owner) | 404 | 404 | ✓ | 403 `NO_ROLE_ASSIGNED` |
| Vendor history | ✓ | ✓ | 403 | ✓ | 403 `NO_ROLE_ASSIGNED` |
| Read approval policy | ✓ | ✓ | ✓ | ✓ | 403 `NO_ROLE_ASSIGNED` |
| Pending-approvals count (approver queue `total`) | 403 | 403 | ✓ | 403 | 403 `NO_ROLE_ASSIGNED` |
| Organisation-wide audit log | 403 | 403 | 403 | ✓ | 403 `NO_ROLE_ASSIGNED` |
| `GET /me`, `PATCH /me` (name only) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Change password; list and revoke own sessions (another user's session → 404) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Own access request: `GET`, `POST /api/me/access-request` | 403 | 403 | 403 | 403 | ✓ |
| `GET /api/admin/users`, `GET /api/admin/users/:id` | 403 | 403 | 403 | ✓ | 403 `NO_ROLE_ASSIGNED` |
| `PATCH /api/admin/users/:id`, send reset email | 403 | 403 | 403 | ✓ (except on an Admin or themself → 409) | 403 `NO_ROLE_ASSIGNED` |
| `GET /api/admin/access-requests`, dismiss | 403 | 403 | 403 | ✓ | 403 `NO_ROLE_ASSIGNED` |

- **Cells added 2026-11-12** (slice 3, owner decision):
  - **Deleted drafts**: the order row is gone, so only an Admin can still read its
    timeline, by the order's id; the former owner gets `404` like everyone else. The
    delete dialog warns the owner of this.
  - **Buyer+Approver order list**: one list holding their own orders (any state) and every
    non-draft order. Slice 4 revisits it together with the approval queue.
  - **Admin on an order write** (create, edit, delete, and later submit and withdraw):
    `403 FORBIDDEN` at route level, before validation, never `NOT_ORDER_OWNER`; the
    problem's `detail` and the web app's message say "Admins can view orders but not
    change them." Clients still branch on `code`.
- **Public endpoints** (no session): login, signup, verify-email, resend-verification,
  forgot-password and reset-password. Refresh, logout and logout-all are authenticated by
  the refresh cookie.
- The operator CLI (ADR-0016) is not an HTTP surface and isn't in the matrix.

## Tests
- Buyer B gets 404 on Buyer A's orders and receipts.
- Approver and Admin see all buyers' orders. Admin order mutations → 403.
- An Approver sees and cancels an auto-approved order.
- A Buyer+Approver who approved A's order gets 403 `NOT_ORDER_OWNER` when receiving on it.
- A no-role user gets `403 NO_ROLE_ASSIGNED` on every gated route, even with an invalid
  body (precedence), and can use `/me`, password, sessions and the access request.
- The full matrix × state × unauthenticated, generated from the route table.
