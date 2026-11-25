import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  approvalPolicy,
  approvalQueueItem,
  approvalQueueQuery,
  approvalRound,
  decisionReasonBody,
  DECISION_REASON_MAX,
  emptyBody,
  fieldErrors,
  order,
  orderListItem,
  ORDER_READ_ONLY_FIELDS,
  vendorOrderSnapshot,
} from '../src/index.js';

// The slice 4 schemas (specs/005-submit-approve/contracts/api.md), reviewed before any
// service code. Failures are read through fieldErrors, as a client sees them.

const ID = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a0b';
const AT = '2026-11-17T10:00:00.000Z';

function failures(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value, { reportInput: true });
  if (result.success) return [];
  return fieldErrors('body', result.error.issues).map((e) => `${e.path} ${e.code}`);
}

const snapshot = {
  id: ID,
  name: 'Acme Supplies',
  contactName: 'Ravi Shah',
  contactEmail: 'ravi@acme.example',
  contactPhone: null,
  paymentTerms: { type: 'NET', netDays: 30 },
};

const round = {
  round: 1,
  policyVersion: 1,
  outcome: null,
  submittedAt: AT,
  closedAt: null,
  withdrawReason: null,
  steps: [
    {
      step: 1,
      tier: 1,
      threshold: '100000.0000',
      state: 'OPEN',
      decidedBy: null,
      decidedAt: null,
      reason: null,
    },
  ],
};

const draftOrder = {
  id: ID,
  poNumber: 'PO-2026-27-000001',
  status: 'DRAFT',
  vendor: { id: ID, name: 'Acme Supplies', status: 'ACTIVE' },
  owner: { id: ID, name: 'Asha Buyer' },
  total: '1.0000',
  lineCount: 1,
  lines: [
    {
      id: ID,
      description: 'Bolts',
      quantity: 1,
      unitPrice: '1.0000',
      lineTotal: '1.0000',
      receivedQuantity: 0,
      outstandingQuantity: 1,
    },
  ],
  version: 1,
  createdAt: AT,
  updatedAt: AT,
  submittedAt: null,
  approvedAt: null,
  ownerCanAct: true,
  vendorSnapshot: null,
  approval: null,
  cancellation: null,
  receiptProgress: 'NOT_RECEIVED',
  receivedLines: { complete: 0, partly: 0, total: 1 },
};

describe('[NFR-VAL-01] slice 4 request schemas', () => {
  it('[NFR-VAL-01] a decision reason is required, trimmed, at most DECISION_REASON_MAX, line breaks allowed', () => {
    expect(failures(decisionReasonBody, { reason: 'Wrong vendor' })).toEqual([]);
    expect(decisionReasonBody.parse({ reason: '  Too dear\nfor now  ' })).toEqual({
      reason: 'Too dear\nfor now',
    });
    expect(failures(decisionReasonBody, {})).toEqual(['body.reason REQUIRED']);
    expect(failures(decisionReasonBody, { reason: null })).toEqual(['body.reason INVALID_FORMAT']);
    expect(failures(decisionReasonBody, { reason: '   ' })).toEqual(['body.reason TOO_SHORT']);
    expect(failures(decisionReasonBody, { reason: 'x'.repeat(DECISION_REASON_MAX + 1) })).toEqual([
      'body.reason TOO_LONG',
    ]);
    expect(failures(decisionReasonBody, { reason: '😀'.repeat(DECISION_REASON_MAX) })).toEqual([]);
    expect(failures(decisionReasonBody, { reason: 'a\tb' })).toEqual([
      'body.reason INVALID_FORMAT',
    ]);
    expect(failures(decisionReasonBody, { reason: 'ok', extra: 1 })).toEqual([
      'body.extra UNKNOWN_FIELD',
    ]);
  });

  it('[NFR-VAL-01] submit and approve take no body, or an empty object, and nothing else', () => {
    expect(failures(emptyBody, undefined)).toEqual([]);
    expect(failures(emptyBody, {})).toEqual([]);
    expect(failures(emptyBody, { version: 2 })).toEqual(['body.version UNKNOWN_FIELD']);
    expect(failures(emptyBody, { status: 'APPROVED' })).toEqual(['body.status UNKNOWN_FIELD']);
  });

  it('[NFR-VAL-01] the approval queue query takes a page, a vendor and a PO-number prefix', () => {
    expect(failures(approvalQueueQuery, {})).toEqual([]);
    expect(approvalQueueQuery.parse({ poNumber: 'po-2026-27-00' }).poNumber).toBe('PO-2026-27-00');
    expect(failures(approvalQueueQuery, { vendorId: 'nope' })).toEqual([
      'body.vendorId INVALID_FORMAT',
    ]);
    expect(failures(approvalQueueQuery, { status: 'DRAFT' })).toEqual([
      'body.status UNKNOWN_FIELD',
    ]);
  });

  it('[NFR-VAL-01] the new order response fields are read-only in any order body', () => {
    for (const key of ['submittedAt', 'approvedAt', 'ownerCanAct', 'vendorSnapshot', 'approval']) {
      expect(ORDER_READ_ONLY_FIELDS, key).toContain(key);
    }
  });
});

describe('[FR-APR-01] slice 4 response schemas', () => {
  it('[FR-APR-01] an order carries its submission, snapshot and current round', () => {
    expect(order.safeParse(draftOrder).success).toBe(true);
    const pending = {
      ...draftOrder,
      status: 'PENDING_APPROVAL',
      submittedAt: AT,
      vendorSnapshot: snapshot,
      approval: round,
      version: 2,
    };
    expect(order.safeParse(pending).success).toBe(true);
    expect(order.safeParse({ ...pending, approval: { ...round, outcome: 'LOST' } }).success).toBe(
      false,
    );
    expect(order.safeParse({ ...draftOrder, ownerCanAct: undefined }).success).toBe(false);
  });

  it('[FR-APR-01] a round step is a decided or open step with its decider and reason', () => {
    const decided = {
      ...round,
      outcome: 'REJECTED',
      closedAt: AT,
      steps: [
        {
          ...round.steps[0],
          state: 'REJECTED',
          decidedBy: { id: ID, name: 'Priya Approver' },
          decidedAt: AT,
          reason: 'Too dear',
        },
      ],
    };
    expect(approvalRound.safeParse(decided).success).toBe(true);
    expect(
      approvalRound.safeParse({ ...decided, steps: [{ ...decided.steps[0], state: 'SKIPPED' }] })
        .success,
    ).toBe(false);
    expect(
      approvalRound.safeParse({ ...round, outcome: 'WITHDRAWN', withdrawReason: 'Typo' }).success,
    ).toBe(true);
  });

  it('[FR-VEN-03] a vendor snapshot has the vendor id, name, contacts and payment terms', () => {
    expect(vendorOrderSnapshot.safeParse(snapshot).success).toBe(true);
    expect(vendorOrderSnapshot.safeParse({ ...snapshot, paymentTerms: undefined }).success).toBe(
      false,
    );
  });

  it('[FR-APR-01] a list item keeps slice 3 shape: no round, snapshot or submission fields', () => {
    const item = {
      id: ID,
      poNumber: 'PO-2026-27-000001',
      status: 'DRAFT',
      vendor: { id: ID, name: 'Acme Supplies' },
      owner: { id: ID, name: 'Asha Buyer' },
      total: '1.0000',
      lineCount: 1,
      createdAt: AT,
    };
    expect(orderListItem.safeParse(item).success).toBe(true);
    expect(orderListItem.safeParse({ ...item, approval: null }).success).toBe(false);
  });

  it('[FR-APR-04] the policy is a version with ordered tiers', () => {
    expect(
      approvalPolicy.safeParse({
        version: 1,
        effectiveAt: AT,
        tiers: [{ tier: 1, threshold: '100000.0000' }],
      }).success,
    ).toBe(true);
  });

  it('[FR-APR-01] a queue item names the order, buyer, vendor, total, step and owner state', () => {
    const item = {
      id: ID,
      poNumber: 'PO-2026-27-000001',
      owner: { id: ID, name: 'Asha Buyer' },
      vendor: { id: ID, name: 'Acme Supplies' },
      total: '150000.0000',
      submittedAt: AT,
      currentStep: { step: 1, tier: 1, of: 1 },
      ownerCanAct: true,
      version: 2,
    };
    expect(approvalQueueItem.safeParse(item).success).toBe(true);
    expect(approvalQueueItem.safeParse({ ...item, ownerCanAct: 'yes' }).success).toBe(false);
  });
});

/** A copy of `value` without `keys`. */
function without(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

describe('[FR-LCK-02] slice 5: the cancel record on an order', () => {
  const cancellation = {
    cancelledBy: { id: ID, name: 'Priya Approver' },
    cancelledAt: AT,
    reason: 'Not needed\nany more',
  };

  it('[FR-LCK-02] an order carries its cancellation: null until cancelled, then who, when and why', () => {
    expect(order.safeParse({ ...draftOrder, status: 'CANCELLED', cancellation }).success).toBe(
      true,
    );
    const withoutField = without(draftOrder, ['cancellation']);
    expect(order.safeParse(withoutField).success).toBe(false);
    expect(
      order.safeParse({ ...draftOrder, cancellation: { ...cancellation, by: 'x' } }).success,
    ).toBe(false);
    expect(
      order.safeParse({
        ...draftOrder,
        cancellation: { ...cancellation, cancelledBy: { id: ID } },
      }).success,
    ).toBe(false);
  });

  it('[FR-LCK-02] list items carry the status only, not the cancellation', () => {
    const item = without(draftOrder, [
      'lines',
      'version',
      'updatedAt',
      'submittedAt',
      'approvedAt',
      'ownerCanAct',
      'vendorSnapshot',
      'approval',
      'cancellation',
      'receiptProgress',
      'receivedLines',
    ]);
    const listed = { ...item, status: 'CANCELLED', vendor: { id: ID, name: 'Acme Supplies' } };
    expect(orderListItem.safeParse(listed).success).toBe(true);
    expect(orderListItem.safeParse({ ...listed, cancellation }).success).toBe(false);
  });

  it('[NFR-VAL-01] the cancel record is read-only in any order body, by every name', () => {
    for (const key of ['cancellation', 'cancelledBy', 'cancelledAt', 'cancelReason']) {
      expect(ORDER_READ_ONLY_FIELDS, key).toContain(key);
    }
  });
});
