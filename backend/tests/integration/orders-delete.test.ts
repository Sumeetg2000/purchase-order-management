import { ORDER_ADMIN_READ_ONLY_MESSAGE, type Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { lineBody, ordersHarness, type OrdersHarness } from '../support/orders.js';

// Deleting a draft (spec US4; FR-007, FR-018, FR-020): the owner removes it with its
// current version and an optional reason; its lines go with it, its PO number is never
// given again, and its audit record outlives it, readable by an Admin only (ADR-0004,
// 2026-11-12).

async function draft(h: OrdersHarness) {
  const res = await h.createOrder(
    h.orderBody([
      lineBody({ description: 'Washers', quantity: 3, unitPrice: '0.1' }),
      lineBody({ description: 'Bolts', quantity: 7, unitPrice: '0.0125' }),
    ]),
  );
  expect(res.status).toBe(201);
  return res.body as Order;
}

describe('[FR-SM-02] delete a draft', () => {
  it('[FR-SM-02] the owner deletes a draft with no body: 204, the order and its lines are gone', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    const res = await h.deleteOrder(order.id, 1);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await h.getOrder(order.id)).status).toBe(404);
    expect(await h.count('purchase_orders')).toBe(0);
    expect(await h.count('order_lines')).toBe(0);
  });

  it('[NFR-AUD-01] PO_DRAFT_DELETED keeps the PO number, the vendor, every line, the total and the reason', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    const res = await h.deleteOrder(order.id, 1, {
      reason: '  Raised twice;\nsee the other one. ',
    });
    expect(res.status).toBe(204);
    const entries = await h.orderAudit();
    expect(entries.map((e) => e.action)).toEqual(['PO_CREATED', 'PO_DRAFT_DELETED']);
    expect(entries[1]).toMatchObject({
      entity_id: order.id,
      order_id: order.id,
      po_number: order.poNumber,
      actor_user_id: h.buyer.id,
      acting_role: 'BUYER',
      request_id: res.get('X-Request-Id'),
      details: {
        poNumber: order.poNumber,
        vendor: { id: h.vendorId, name: 'Acme Supplies' },
        lines: order.lines.map(({ id, description, quantity, unitPrice, lineTotal }) => ({
          id,
          description,
          quantity,
          unitPrice,
          lineTotal,
        })),
        total: '0.3875',
        reason: 'Raised twice;\nsee the other one.',
      },
    });
  });

  it('[FR-SM-02] a reason is optional: {} and {"reason": null} record null', async () => {
    const h = await ordersHarness();
    for (const body of [{}, { reason: null }]) {
      const order = await draft(h);
      expect((await h.deleteOrder(order.id, 1, body)).status).toBe(204);
    }
    const reasons = (await h.orderAudit())
      .filter((e) => e.action === 'PO_DRAFT_DELETED')
      .map((e) => (e.details as { reason: unknown }).reason);
    expect(reasons).toEqual([null, null]);
  });

  it('[NFR-VAL-01] a bad reason, a stale or missing version, or a malformed id deletes nothing', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    expect((await h.deleteOrder(order.id, 1, { reason: '' })).body).toMatchObject({
      details: [{ path: 'body.reason', code: 'TOO_SHORT' }],
    });
    expect((await h.deleteOrder(order.id, 1, { reason: 'x', total: '1' })).body).toMatchObject({
      details: [{ path: 'body.total', code: 'UNKNOWN_FIELD' }],
    });
    const stale = await h.deleteOrder(order.id, 2);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    const missing = await h.deleteOrder(order.id, null);
    expect(missing.body).toMatchObject({
      details: [{ path: 'header.if-match', code: 'VERSION_REQUIRED' }],
    });
    const malformed = await h.deleteOrder('not-a-uuid', 1);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      details: [{ path: 'path.id', code: 'INVALID_FORMAT' }],
    });
    expect((await h.getOrder(order.id)).status).toBe(200);
    expect((await h.orderAudit()).map((e) => e.action)).toEqual(['PO_CREATED']);
  });

  it("[FR-PO-05] a deleted draft's PO number is never given again", async () => {
    const h = await ordersHarness();
    const first = await draft(h);
    expect((await h.deleteOrder(first.id, 1)).status).toBe(204);
    const next = await draft(h);
    const seq = (n: string) => Number(n.split('-').at(-1));
    expect(seq(next.poNumber)).toBe(seq(first.poNumber) + 1);
  });

  it('[FR-OWN-01] another Buyer gets 404; an Admin 403 with the read-only detail; nothing is deleted', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));
    expect((await h.deleteOrder(order.id, 1, undefined, other)).status).toBe(404);
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const refused = await h.deleteOrder(order.id, 1, { bogus: 1 }, admin);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: 'FORBIDDEN',
      detail: ORDER_ADMIN_READ_ONLY_MESSAGE,
    });
    expect((await h.getOrder(order.id)).status).toBe(200);
  });
});

describe('[NFR-AUD-03] the timeline of a deleted draft', () => {
  it('[NFR-AUD-03] an Admin reads it by the order id; the former owner, another Buyer and an Approver get 404', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    expect((await h.deleteOrder(order.id, 1, { reason: 'Duplicate' })).status).toBe(204);
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const read = await h.get(`/orders/${order.id}/timeline`, admin);
    expect(read.status).toBe(200);
    expect((read.body as { items: { action: string }[] }).items.map((i) => i.action)).toEqual([
      'PO_DRAFT_DELETED',
      'PO_CREATED',
    ]);
    const others = [
      h.jar,
      await h.loggedIn(await h.seedUser({ roles: '{BUYER}' })),
      await h.loggedIn(await h.seedUser({ roles: '{APPROVER}' })),
    ];
    for (const jar of others) {
      const res = await h.get(`/orders/${order.id}/timeline`, jar);
      expect(res.status).toBe(404);
    }
  });
});
