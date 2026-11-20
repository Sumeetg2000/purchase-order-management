import { z } from 'zod';
import {
  APPROVAL_ROUND_OUTCOMES,
  APPROVAL_STEP_STATES,
  DECISION_REASON_MAX,
} from '../approvals.js';
import { money } from '../money.js';
import { pageQueryShape } from './pagination.js';
import { plainText, poNumberPrefix } from './text.js';
import { paymentTerms } from './vendors.js';

// Submission, routing and decisions (specs/005-submit-approve/contracts/api.md).

/** Reject and withdraw: a required reason, the delete reason's rules (line breaks allowed). */
export const decisionReasonBody = z
  .strictObject({ reason: plainText(DECISION_REASON_MAX, /\r?\n|\r/g) })
  .meta({ id: 'DecisionReasonBody' });

/** Submit and approve take no input besides If-Match: no body, or an empty object. */
export const emptyBody = z.strictObject({}).optional();

/** The vendor as it was at submit (ADR-0005): what a non-draft order shows. */
export const vendorOrderSnapshot = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    contactName: z.string().nullable(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    paymentTerms,
  })
  .meta({ id: 'VendorOrderSnapshot' });

export const approvalStep = z
  .strictObject({
    step: z.int(),
    tier: z.int(),
    threshold: money,
    state: z.enum(APPROVAL_STEP_STATES),
    decidedBy: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
    decidedAt: z.iso.datetime().nullable(),
    /** A rejection's reason; null otherwise. */
    reason: z.string().nullable(),
  })
  .meta({ id: 'ApprovalStep' });

/** One submission of an order: its policy version, outcome and steps (research R2). */
export const approvalRound = z
  .strictObject({
    round: z.int(),
    policyVersion: z.int(),
    outcome: z.enum(APPROVAL_ROUND_OUTCOMES).nullable(),
    submittedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
    withdrawReason: z.string().nullable(),
    steps: z.array(approvalStep),
  })
  .meta({ id: 'ApprovalRound' });

export const approvalQueueQuery = z.strictObject({
  ...pageQueryShape,
  vendorId: z.uuid().optional(),
  /** With a prefix the queue is sorted by PO number, newest first (as order lists). */
  poNumber: poNumberPrefix.optional(),
});

export const approvalQueueItem = z
  .strictObject({
    id: z.uuid(),
    poNumber: z.string(),
    owner: z.strictObject({ id: z.uuid(), name: z.string() }),
    /** The vendor's name as submitted. */
    vendor: z.strictObject({ id: z.uuid(), name: z.string() }),
    total: money,
    submittedAt: z.iso.datetime(),
    currentStep: z.strictObject({ step: z.int(), tier: z.int(), of: z.int() }),
    ownerCanAct: z.boolean(),
    version: z.int(),
  })
  .meta({ id: 'ApprovalQueueItem' });

export const approvalPolicy = z
  .strictObject({
    version: z.int(),
    effectiveAt: z.iso.datetime(),
    tiers: z.array(z.strictObject({ tier: z.int(), threshold: money })),
  })
  .meta({ id: 'ApprovalPolicy' });

export type DecisionReasonBody = z.infer<typeof decisionReasonBody>;
export type VendorOrderSnapshot = z.infer<typeof vendorOrderSnapshot>;
export type ApprovalStep = z.infer<typeof approvalStep>;
export type ApprovalRound = z.infer<typeof approvalRound>;
export type ApprovalQueueQuery = z.infer<typeof approvalQueueQuery>;
export type ApprovalQueueItem = z.infer<typeof approvalQueueItem>;
export type ApprovalPolicy = z.infer<typeof approvalPolicy>;
