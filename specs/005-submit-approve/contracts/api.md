# API contract: Slice 4 — Submission, routing, approval, rejection and withdrawal

Zod first (`packages/contracts`); the OpenAPI is generated. This file is the reviewed
schema and OpenAPI diff (gate 2). Research references are to [research.md](../research.md).

## Constants (`packages/contracts/src/approvals.ts`, new; `orders.ts`, extended)

```ts
export const APPROVAL_POLICY_SEED_TIERS = ['100000.0000'] as const;      // R1, pinned to SQL
export const APPROVAL_ROUND_OUTCOMES = ['AUTO_APPROVED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export const APPROVAL_STEP_STATES = ['OPEN', 'APPROVED', 'REJECTED', 'VOIDED'] as const;
export const DECISION_REASON_MAX = 500;                                 // reject, withdraw
export const ORDER_TRANSITIONS = [                                      // pinned to the table
  ['DRAFT', 'APPROVED'], ['DRAFT', 'PENDING_APPROVAL'],
  ['PENDING_APPROVAL', 'APPROVED'], ['PENDING_APPROVAL', 'REJECTED'], ['PENDING_APPROVAL', 'DRAFT'],
] as const;
export const ORDER_LOCKED_MESSAGES = {
  APPROVED: 'This order is approved and locked.',
  REJECTED: 'This order was rejected and is closed. Raise a new order instead.',
} as const satisfies Partial<Record<OrderStatus, string>>;
export const ORDER_OWNER_CANNOT_ACT_LABEL = 'Owner can no longer act on this order';
// orders.ts, beside ORDER_ADMIN_READ_ONLY_MESSAGE (ADR-0004, 2026-11-17):
export const ORDER_APPROVER_READ_ONLY_MESSAGE = 'Approvers can review orders but not change them.';
export const ORDER_DECISION_APPROVER_ONLY_MESSAGE = 'Only Approvers can approve or reject orders.';
// orders.ts: ORDER_AUDIT_ACTIONS gains PO_SUBMITTED, PO_AUTO_APPROVED,
// APPROVAL_STEP_APPROVED, APPROVAL_STEP_REJECTED, PO_WITHDRAWN.
```

## Schemas (`schemas/approvals.ts`, new; `schemas/orders.ts`, extended)

```ts
export const decisionReasonBody = z.strictObject({
  reason: plainText(DECISION_REASON_MAX, /\r?\n|\r/g),   // required; slice 3's rules, not optional
});
export const emptyBody = z.strictObject({}).optional();  // submit, approve: none or {}

export const approvalStep = z.object({
  step: z.int(), tier: z.int(), threshold: money,
  state: z.enum(APPROVAL_STEP_STATES),
  decidedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
});
export const approvalRound = z.object({
  round: z.int(), policyVersion: z.int(),
  outcome: z.enum(APPROVAL_ROUND_OUTCOMES).nullable(),
  submittedAt: z.iso.datetime(), closedAt: z.iso.datetime().nullable(),
  withdrawReason: z.string().nullable(),
  steps: z.array(approvalStep),
});
export const vendorOrderSnapshot = z.object({
  id: z.uuid(), name: z.string(), contactName: z.string().nullable(),
  contactEmail: z.string().nullable(), contactPhone: z.string().nullable(),
  paymentTerms,                                         // slice 2's schema
});

// order (slice 3) gains:
//   submittedAt: datetime | null, approvedAt: datetime | null,
//   ownerCanAct: boolean,
//   vendorSnapshot: vendorOrderSnapshot | null   (non-draft: the current round's)
//   approval: approvalRound | null               (current round; a withdrawn draft shows it)
// orderListItem: vendor.name is the snapshot name for non-draft orders (no shape change).

export const approvalQueueQuery = pageQuery.extend({
  vendorId: z.uuid().optional(),
  poNumber: poNumberPrefix.optional(),                  // slice 3's rule; sorts by PO number desc
});
export const approvalQueueItem = z.object({
  id: z.uuid(), poNumber: z.string(),
  owner: z.object({ id: z.uuid(), name: z.string() }),
  vendor: z.object({ id: z.uuid(), name: z.string() }), // snapshot name
  total: money, submittedAt: z.iso.datetime(),
  currentStep: z.object({ step: z.int(), tier: z.int(), of: z.int() }),
  ownerCanAct: z.boolean(),
  version: z.int(),
});
export const approvalPolicy = z.object({
  version: z.int(), effectiveAt: z.iso.datetime(),
  tiers: z.array(z.object({ tier: z.int(), threshold: money })),
});
```

`ORDER_READ_ONLY_FIELDS` gains `submittedAt`, `approvedAt`, `ownerCanAct`,
`vendorSnapshot`, `approval` (so an order body echoing them gets `READ_ONLY_FIELD`).

## Operations

| operationId | Method and path | Access | Request | Success | Errors beyond the common set |
|---|---|---|---|---|---|
| `submitOrder` | `POST /orders/:id/submit` | role: BUYER, `ifMatch`; role details | `idParams`, `emptyBody` | 200 `order`, `ETag` | `NOT_FOUND`, `NOT_ORDER_OWNER`, `INVALID_STATE_TRANSITION`, `VERSION_CONFLICT`, `VENDOR_INACTIVE` |
| `withdrawOrder` | `POST /orders/:id/withdraw` | role: BUYER, `ifMatch`; role details | `idParams`, `decisionReasonBody` | 200 `order`, `ETag` | `NOT_FOUND`, `NOT_ORDER_OWNER`, `INVALID_STATE_TRANSITION`, `VERSION_CONFLICT` |
| `approveOrder` | `POST /orders/:id/approve` | role: APPROVER, `ifMatch`; role details | `idParams`, `emptyBody` | 200 `order`, `ETag` | `ACCOUNT_DEACTIVATED`, `FORBIDDEN` (re-check under lock), `NOT_FOUND`, `SELF_APPROVAL`, `INVALID_STATE_TRANSITION`, `VERSION_CONFLICT`, `VENDOR_INACTIVE`, `ORDER_OWNER_INACTIVE` |
| `rejectOrder` | `POST /orders/:id/reject` | role: APPROVER, `ifMatch`; role details | `idParams`, `decisionReasonBody` | 200 `order`, `ETag` | `ACCOUNT_DEACTIVATED`, `FORBIDDEN` (re-check under lock), `NOT_FOUND`, `SELF_APPROVAL`, `INVALID_STATE_TRANSITION`, `VERSION_CONFLICT` |
| `listApprovalQueue` | `GET /approvals` | role: APPROVER | query `approvalQueueQuery` | 200 `pageOf(approvalQueueItem)` | — |
| `getApprovalPolicy` | `GET /approval-policy` | role: BUYER, APPROVER, ADMIN | — | 200 `approvalPolicy` | — |

Changed operations (errors now reachable, documented):
- `editOrder`, `deleteOrder`: + `NOT_ORDER_OWNER`, `ORDER_PENDING_APPROVAL`,
  `ORDER_LOCKED` (with `orderState.status`); role details as below.
- `getOrder`, `listOrders`, `listOrderTimeline`: response shapes above; Approver scope
  now non-empty.

"Role details" (ADR-0004, 2026-11-17): `OperationContract.adminForbiddenDetail`
becomes `forbiddenDetail`, a map from the caller's role set to the `403 FORBIDDEN`
`detail`. Order writes (create, edit, delete, submit, withdraw): Admin →
`ORDER_ADMIN_READ_ONLY_MESSAGE`, pure Approver → `ORDER_APPROVER_READ_ONLY_MESSAGE`.
Approve and reject: Admin → `ORDER_ADMIN_READ_ONLY_MESSAGE`, pure Buyer →
`ORDER_DECISION_APPROVER_ONLY_MESSAGE`. The slice 3 operations move to the map with no
behaviour change for Admins.

Sorts: queue `submittedAt ASC, id ASC`, or `poNumber DESC` with the prefix filter.

## Body-schema inventory additions

`submitOrder` (no fields), `approveOrder` (no fields), `withdrawOrder` (`reason` req),
`rejectOrder` (`reason` req).

## OpenAPI diff (additive only)

- 6 new operations on 5 new paths; schemas `ApprovalStep`, `ApprovalRound`,
  `VendorOrderSnapshot`, `ApprovalQueueItem`, `PageOfApprovalQueueItem`, `ApprovalPolicy`,
  `DecisionReasonBody`.
- `Order` gains optional-to-old-clients fields `submittedAt`, `approvedAt`, `ownerCanAct`,
  `vendorSnapshot`, `approval` (additive; no removed or narrowed field).
- `ErrorCode` (`x-extensible-enum`) gains `ORDER_PENDING_APPROVAL`,
  `ORDER_OWNER_INACTIVE`, `ORDER_LOCKED`, `NOT_ORDER_OWNER`, `SELF_APPROVAL`.
- The breaking-change check stays green.
