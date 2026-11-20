import type { Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { ordersHarness } from '../support/orders.js';

// Routing on submit (ADR-0002, research R3): the exact total against the highest policy
// version, one step per tier strictly exceeded, the version recorded on the round.

describe('[FR-APR-01] routing by the seeded policy (one tier, ₹1,00,000)', () => {
  it('[FR-APR-01] at the threshold auto-approves; one ten-thousandth above, or one paisa, needs one step', async () => {
    const h = await ordersHarness();
    const outcomes: Record<string, unknown> = {};
    for (const price of ['100000.0000', '100000.0001', '100000.0100']) {
      const draft = await h.draftAt(price);
      const res = await h.submitOrder(draft.id, 1);
      expect(res.status, price).toBe(200);
      const order = res.body as Order;
      outcomes[price] = {
        status: order.status,
        steps: order.approval?.steps.map((s) => `${String(s.tier)} ${s.state}`),
        outcome: order.approval?.outcome,
        policyVersion: order.approval?.policyVersion,
      };
    }
    expect(outcomes).toEqual({
      '100000.0000': { status: 'APPROVED', steps: [], outcome: 'AUTO_APPROVED', policyVersion: 1 },
      '100000.0001': {
        status: 'PENDING_APPROVAL',
        steps: ['1 OPEN'],
        outcome: null,
        policyVersion: 1,
      },
      '100000.0100': {
        status: 'PENDING_APPROVAL',
        steps: ['1 OPEN'],
        outcome: null,
        policyVersion: 1,
      },
    });
  });
});

describe('[FR-APR-03] a variable-length chain from policy data, no special case', () => {
  it('[FR-APR-03] a two-tier fixture gives two steps above both tiers, one between them', async () => {
    const h = await ordersHarness();
    await h.addPolicy(2, ['100000', '1000000']);
    const high = await h.draftAt('2000000');
    const mid = await h.draftAt('500000');
    const highOrder = (await h.submitOrder(high.id, 1)).body as Order;
    const midOrder = (await h.submitOrder(mid.id, 1)).body as Order;
    expect(highOrder.approval?.steps.map((s) => [s.step, s.tier, s.threshold])).toEqual([
      [1, 1, '100000.0000'],
      [2, 2, '1000000.0000'],
    ]);
    expect(highOrder.approval?.policyVersion).toBe(2);
    expect(midOrder.approval?.steps.map((s) => s.tier)).toEqual([1]);
  });

  it('[FR-APR-03] a three-tier chain comes from inserting policy rows only', async () => {
    const h = await ordersHarness();
    await h.addPolicy(2, ['1000', '10000', '100000']);
    const draft = await h.draftAt('250000');
    const order = (await h.submitOrder(draft.id, 1)).body as Order;
    expect(order.approval?.steps.map((s) => s.tier)).toEqual([1, 2, 3]);
  });

  it('[FR-APR-03] a policy version added after submit leaves the chain as it was', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    await h.submitOrder(draft.id, 1);
    await h.addPolicy(2, ['100000', '120000']);
    const order = (await h.getOrder(draft.id)).body as Order;
    expect(order.approval).toMatchObject({ policyVersion: 1, steps: [{ tier: 1 }] });
  });
});
