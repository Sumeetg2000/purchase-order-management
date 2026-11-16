import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lineBody, ordersHarness } from '../support/orders.js';

// The create's audit entry (FR-020, ADR-0016): exactly one PO_CREATED, in the create's
// transaction, with who acted, the PO number, the vendor, every line and the total; none for
// a refused, replayed or rolled-back create.

describe('[NFR-AUD-01] PO_CREATED', () => {
  it('[NFR-AUD-01] one entry per create, with the actor, the PO number, the vendor, every line and the total', async () => {
    const h = await ordersHarness();
    const res = await h.createOrder(
      h.orderBody([
        lineBody({ description: 'Washers', quantity: 3, unitPrice: '0.1' }),
        lineBody({ description: 'Bolts', quantity: 7, unitPrice: '0.0125' }),
      ]),
    );
    expect(res.status).toBe(201);
    const order = res.body as {
      id: string;
      poNumber: string;
      lines: { id: string }[];
    };
    const entries = await h.orderAudit();
    expect(entries).toEqual([
      {
        action: 'PO_CREATED',
        entity_type: 'order',
        entity_id: order.id,
        order_id: order.id,
        po_number: order.poNumber,
        actor_type: 'USER',
        actor_user_id: h.buyer.id,
        actor_name: 'Bea Buyer',
        actor_email: h.buyer.email,
        acting_role: 'BUYER',
        request_id: res.get('X-Request-Id'),
        details: {
          vendor: { id: h.vendorId, name: 'Acme Supplies' },
          lines: [
            {
              id: order.lines[0]?.id,
              description: 'Washers',
              quantity: 3,
              unitPrice: '0.1000',
              lineTotal: '0.3000',
            },
            {
              id: order.lines[1]?.id,
              description: 'Bolts',
              quantity: 7,
              unitPrice: '0.0125',
              lineTotal: '0.0875',
            },
          ],
          total: '0.3875',
        },
      },
    ]);
  });

  it('[NFR-AUD-01] a refused, replayed or invalid create writes no entry', async () => {
    const h = await ordersHarness();
    const inactive = await h.seedVendor({ name: 'Closed Co', status: 'INACTIVE' });
    expect((await h.createOrder(h.orderBody([lineBody()], { vendorId: inactive }))).status).toBe(
      409,
    );
    expect((await h.createOrder(h.orderBody([lineBody({ quantity: 0 })]))).status).toBe(400);
    const key = randomUUID();
    expect((await h.createOrder(h.orderBody(), { key })).status).toBe(201);
    expect((await h.createOrder(h.orderBody(), { key })).status).toBe(201);
    expect((await h.orderAudit()).map((e) => e.action)).toEqual(['PO_CREATED']);
  });
});
