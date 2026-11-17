import type { Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { ordersHarness } from '../support/orders.js';

// The submit's audit entries (FR-020, ADR-0016 amended 2026-11-17): PO_SUBMITTED by the
// owner, PO_AUTO_APPROVED by SYSTEM, in the submit's transaction; none for a refusal.

describe('[NFR-AUD-01] submit audit entries', () => {
  it('[NFR-AUD-01] a pending submit writes PO_SUBMITTED by the owner, with round, routing and snapshot', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    const order = (await h.submitOrder(draft.id, 1)).body as Order;
    const entries = (await h.orderAudit()).filter((e) => e.action !== 'PO_CREATED');
    expect(entries).toEqual([
      expect.objectContaining({
        action: 'PO_SUBMITTED',
        order_id: draft.id,
        po_number: order.poNumber,
        actor_type: 'USER',
        actor_user_id: h.buyer.id,
        acting_role: 'BUYER',
        details: {
          round: 1,
          total: '150000.0000',
          tiers: [{ tier: 1, threshold: '100000.0000' }],
          policyVersion: 1,
          resultingStatus: 'PENDING_APPROVAL',
          vendorSnapshot: order.vendorSnapshot,
        },
      }),
    ]);
  });

  it('[NFR-AUD-01] an auto-approval adds PO_AUTO_APPROVED by SYSTEM, no user fields', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('99');
    await h.submitOrder(draft.id, 1);
    const entries = (await h.orderAudit()).filter((e) => e.action !== 'PO_CREATED');
    expect(entries.map((e) => [e.action, e.actor_type])).toEqual([
      ['PO_SUBMITTED', 'USER'],
      ['PO_AUTO_APPROVED', 'SYSTEM'],
    ]);
    expect(entries[0]?.details).toMatchObject({ tiers: [], resultingStatus: 'APPROVED' });
    expect(entries[1]).toMatchObject({
      actor_user_id: null,
      actor_name: null,
      acting_role: null,
      request_id: entries[0]?.request_id,
      details: { round: 1, threshold: '100000.0000', policyVersion: 1 },
    });
  });

  it('[NFR-AUD-01] a refused submit writes nothing', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('99');
    await h.submitOrder(draft.id, 5);
    expect((await h.orderAudit()).map((e) => e.action)).toEqual(['PO_CREATED']);
  });
});
