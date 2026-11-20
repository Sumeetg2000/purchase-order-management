import type { OrderStatus } from './orders.js';

// Approval constants (ADR-0001, ADR-0002; specs/005-submit-approve/data-model.md). The
// approval tables' CHECKs and seed (migration 0014_approvals) hold SQL copies of these;
// backend/tests/integration/order-constants.test.ts pins each copy.

/** The production seed policy: one tier, above which an order needs one approval. */
export const APPROVAL_POLICY_SEED_TIERS = ['100000.0000'] as const;

/** How a submission (an approval round) ended; null while it is open. */
export const APPROVAL_ROUND_OUTCOMES = [
  'AUTO_APPROVED',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type ApprovalRoundOutcome = (typeof APPROVAL_ROUND_OUTCOMES)[number];

/** The state of one tier step of a round. */
export const APPROVAL_STEP_STATES = ['OPEN', 'APPROVED', 'REJECTED', 'VOIDED'] as const;
export type ApprovalStepState = (typeof APPROVAL_STEP_STATES)[number];

/** A reject or withdraw reason, in Unicode code points. */
export const DECISION_REASON_MAX = 500;

/** The order status changes the database allows (T4, T5, T7, T8, T9, T10 of ADR-0001). */
export const ORDER_TRANSITIONS = [
  ['DRAFT', 'APPROVED'],
  ['DRAFT', 'PENDING_APPROVAL'],
  ['PENDING_APPROVAL', 'APPROVED'],
  ['PENDING_APPROVAL', 'REJECTED'],
  ['PENDING_APPROVAL', 'DRAFT'],
  ['APPROVED', 'CANCELLED'],
] as const satisfies readonly (readonly [OrderStatus, OrderStatus])[];

// Problem details of the slice 4 codes (contracts/errors.md, owner decisions 2026-11-17):
// the API's `detail` and the web app's message use the same constant.

export const ORDER_PENDING_APPROVAL_DETAIL =
  'This order is waiting for approval. Withdraw it to make changes.';
export const ORDER_OWNER_INACTIVE_DETAIL =
  'The buyer who raised this order can no longer act on it. Reject it, or approve once their access is restored.';
/** ORDER_LOCKED's detail by the order's status; slice 5 adds CANCELLED. */
export const ORDER_LOCKED_MESSAGES = {
  APPROVED: 'This order is approved and locked.',
  REJECTED: 'This order was rejected and is closed. Raise a new order instead.',
} as const satisfies Partial<Record<OrderStatus, string>>;
export type LockedOrderStatus = keyof typeof ORDER_LOCKED_MESSAGES;
export const NOT_ORDER_OWNER_DETAIL = 'Only the buyer who raised this order can do that.';
export const SELF_APPROVAL_DETAIL = "You can't approve or reject an order you raised.";
/** The marker on an order whose owner is deactivated or no longer a Buyer (ADR-0004 S5). */
export const ORDER_OWNER_CANNOT_ACT_LABEL = 'Owner can no longer act on this order';
