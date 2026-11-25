import { ACME_ID } from './vendors';

// Order fixtures for component tests, shaped as the API returns them.

export const ORDER_ID = '0192e4a0-0000-7000-8000-0000000000b1';
const BUYER_ID = '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f';

export const orderLine = (extra: Record<string, unknown> = {}) => {
  const quantity = typeof extra['quantity'] === 'number' ? extra['quantity'] : 3;
  const received = typeof extra['receivedQuantity'] === 'number' ? extra['receivedQuantity'] : 0;
  return {
    id: '0192e4a0-0000-7000-8000-0000000000c1',
    description: 'Washers',
    quantity,
    unitPrice: '0.1000',
    lineTotal: '0.3000',
    // Slice 6: what was received, and what is still to come.
    receivedQuantity: received,
    outstandingQuantity: quantity - received,
    ...extra,
  };
};

export const order = (extra: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  poNumber: 'PO-2026-27-000123',
  status: 'DRAFT',
  vendor: { id: ACME_ID, name: 'Acme Supplies', status: 'ACTIVE' },
  owner: { id: BUYER_ID, name: 'Bea Buyer' },
  total: '0.3875',
  lineCount: 2,
  lines: [
    orderLine(),
    orderLine({
      id: '0192e4a0-0000-7000-8000-0000000000c2',
      description: 'Bolts',
      quantity: 7,
      unitPrice: '0.0125',
      lineTotal: '0.0875',
    }),
  ],
  version: 1,
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z',
  submittedAt: null,
  approvedAt: null,
  ownerCanAct: true,
  vendorSnapshot: null,
  approval: null,
  cancellation: null,
  receiptProgress: 'NOT_RECEIVED',
  receivedLines: { complete: 0, partly: 0, total: 2 },
  ...extra,
});

/** The seeded policy as GET /approval-policy returns it. */
export const policy = (threshold = '100000.0000') => ({
  version: 1,
  effectiveAt: '2026-11-01T00:00:00.000Z',
  tiers: [{ tier: 1, threshold }],
});

/** A pending round under the seeded policy: one open step. */
export const pendingRound = () => ({
  round: 1,
  policyVersion: 1,
  outcome: null,
  submittedAt: '2026-11-17T10:00:00.000Z',
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
});

/** A pending order above the seeded tier, its one step open. */
export const pendingOrder = (extra: Record<string, unknown> = {}) =>
  order({
    status: 'PENDING_APPROVAL',
    total: '150000.0000',
    version: 2,
    submittedAt: '2026-11-17T10:00:00.000Z',
    vendorSnapshot: {
      id: ACME_ID,
      name: 'Acme Supplies (as submitted)',
      contactName: 'Ravi Shah',
      contactEmail: 'ravi@acme.example',
      contactPhone: null,
      paymentTerms: { type: 'NET', netDays: 30 },
    },
    approval: pendingRound(),
    ...extra,
  });

/** The pending order above, its step approved by Priya: version 3. */
export const approvedOrder = (extra: Record<string, unknown> = {}) =>
  pendingOrder({
    status: 'APPROVED',
    version: 3,
    approvedAt: '2026-11-18T05:30:00.000Z',
    approval: {
      ...pendingRound(),
      outcome: 'APPROVED',
      closedAt: '2026-11-18T05:30:00.000Z',
      steps: [
        {
          ...pendingRound().steps[0],
          state: 'APPROVED',
          decidedBy: { id: '0192e4a0-0000-7000-8000-00000000aaaa', name: 'Priya Approver' },
          decidedAt: '2026-11-18T05:30:00.000Z',
        },
      ],
    },
    ...extra,
  });

/** The approved order above, cancelled by Priya: version 4. */
export const cancelledOrder = (extra: Record<string, unknown> = {}) =>
  approvedOrder({
    status: 'CANCELLED',
    version: 4,
    cancellation: {
      cancelledBy: { id: '0192e4a0-0000-7000-8000-00000000aaaa', name: 'Priya Approver' },
      cancelledAt: '2026-11-19T06:00:00.000Z',
      reason: 'Supplier closed',
    },
    ...extra,
  });

/** One row of GET /approvals. */
export const queueItem = (extra: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  poNumber: 'PO-2026-27-000123',
  owner: { id: BUYER_ID, name: 'Bea Buyer' },
  vendor: { id: ACME_ID, name: 'Acme Supplies' },
  total: '150000.0000',
  submittedAt: '2026-11-17T10:00:00.000Z',
  currentStep: { step: 1, tier: 1, of: 1 },
  ownerCanAct: true,
  version: 2,
  ...extra,
});
