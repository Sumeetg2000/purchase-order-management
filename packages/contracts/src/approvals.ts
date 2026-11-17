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

/** The order status changes the database allows (T4, T5, T7, T8, T9 of ADR-0001). */
export const ORDER_TRANSITIONS = [
  ['DRAFT', 'APPROVED'],
  ['DRAFT', 'PENDING_APPROVAL'],
  ['PENDING_APPROVAL', 'APPROVED'],
  ['PENDING_APPROVAL', 'REJECTED'],
  ['PENDING_APPROVAL', 'DRAFT'],
] as const satisfies readonly (readonly [OrderStatus, OrderStatus])[];
