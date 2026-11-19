import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME } from './support/fake-api';
import { order, ORDER_ID, pendingOrder, pendingRound } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// A submitted order's detail (contracts/ui.md): the vendor as submitted, with its contacts
// and terms; the Approval panel with its round, policy version, and each step's decider,
// time and reason.

afterEach(() => {
  vi.unstubAllGlobals();
});

const OWNER = { ...ME, id: order().owner.id, roles: ['BUYER'] };
const DECIDER = { id: '0192e4a0-0000-7000-8000-00000000aaaa', name: 'Asha Approver' };

function show(shown: Record<string, unknown>) {
  fakeApi({
    'GET /me': () => json(200, OWNER),
    [`GET /orders/${ORDER_ID}`]: () => json(200, shown, { ETag: '"3"' }),
    'GET /orders': () => json(200, page([])),
  });
  renderApp(`/orders/${ORDER_ID}`);
}

/** A two-step round under policy version 2, its second submission. */
const twoSteps = (states: [string, string], extra: Record<string, unknown> = {}) => ({
  ...pendingRound(),
  round: 2,
  policyVersion: 2,
  steps: [
    {
      ...pendingRound().steps[0],
      state: states[0],
      decidedBy: states[0] === 'OPEN' || states[0] === 'VOIDED' ? null : DECIDER,
      decidedAt: states[0] === 'OPEN' || states[0] === 'VOIDED' ? null : '2026-11-18T05:30:00.000Z',
      reason: states[0] === 'REJECTED' ? 'Quote expired' : null,
    },
    {
      step: 2,
      tier: 2,
      threshold: '1000000.0000',
      state: states[1],
      decidedBy: null,
      decidedAt: null,
      reason: null,
    },
  ],
  ...extra,
});

describe('[FR-VEN-03] the vendor as submitted', () => {
  it('[FR-VEN-03] a submitted order shows the snapshot: name, contact and terms, labelled as submitted', async () => {
    show(
      pendingOrder({
        vendorSnapshot: {
          id: pendingOrder().vendor.id,
          name: 'Acme Supplies',
          contactName: 'Ravi Shah',
          contactEmail: 'ravi@acme.example',
          contactPhone: '+91 22 4000 1234',
          paymentTerms: { type: 'NET', netDays: 30 },
        },
      }),
    );
    const vendor = await screen.findByRole('group', { name: 'Vendor as submitted' });
    expect(vendor).toHaveTextContent('Acme Supplies');
    expect(vendor).toHaveTextContent('Ravi Shah');
    expect(vendor).toHaveTextContent('ravi@acme.example');
    expect(vendor).toHaveTextContent('+91 22 4000 1234');
    expect(vendor).toHaveTextContent('Net 30');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-VEN-03] a draft shows the vendor as it is now, with no snapshot', async () => {
    show(order());
    await screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });
    expect(screen.queryByRole('group', { name: 'Vendor as submitted' })).toBeNull();
  });
});

describe('[FR-APR-03] the Approval panel', () => {
  it('[FR-APR-03] names the round and the policy version, and when each step was decided', async () => {
    show(pendingOrder({ approval: twoSteps(['APPROVED', 'OPEN']) }));
    const panel = await screen.findByRole('region', { name: 'Approval' });
    expect(panel).toHaveTextContent('Round 2 · policy version 2');
    const steps = within(panel).getAllByRole('definition');
    expect(steps[0]).toHaveTextContent('Approved by Asha Approver on 18 November 2026 at 11:00 am');
    expect(steps[1]).toHaveTextContent('Waiting');
  });

  it('[FR-SM-03] a step voided by a rejection says so, not a withdrawal', async () => {
    show(
      pendingOrder({
        status: 'REJECTED',
        approval: twoSteps(['REJECTED', 'VOIDED'], {
          outcome: 'REJECTED',
          closedAt: '2026-11-18T05:30:00.000Z',
        }),
      }),
    );
    const panel = await screen.findByRole('region', { name: 'Approval' });
    const steps = within(panel).getAllByRole('definition');
    expect(steps[0]).toHaveTextContent(
      'Rejected by Asha Approver on 18 November 2026 at 11:00 am: Quote expired',
    );
    expect(steps[1]).toHaveTextContent('Voided by the rejection');
    expect(panel).not.toHaveTextContent('withdrawal');
  });

  it('[FR-APR-02] a step voided by a withdrawal still says so', async () => {
    show(
      order({
        version: 4,
        approval: {
          ...pendingRound(),
          outcome: 'WITHDRAWN',
          closedAt: '2026-11-18T05:30:00.000Z',
          withdrawReason: 'Splitting the order',
          steps: [{ ...pendingRound().steps[0], state: 'VOIDED' }],
        },
      }),
    );
    const panel = await screen.findByRole('region', { name: 'Approval' });
    expect(within(panel).getByRole('definition')).toHaveTextContent('Voided by a withdrawal');
  });
});
