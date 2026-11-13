import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CookieJar } from '../support/accounts.js';
import { lineBody, ordersHarness, type OrdersHarness } from '../support/orders.js';

// An order's timeline (FR-018, NFR-AUD-03): its audit entries, newest first, paginated,
// each with who acted, in what capacity, when, and what changed. Its owner and an Admin
// read it; anyone else, and any id that never was an order, gets 404.

interface Timeline {
  items: {
    id: string;
    action: string;
    occurredAt: string;
    actor: { type: string; name: string | null; email: string | null; role: string | null };
    details: Record<string, unknown>;
  }[];
  total: number;
}

function timeline(h: OrdersHarness, id: string, as: CookieJar = h.jar, query = '') {
  return h.get(`/orders/${id}/timeline${query}`, as);
}

async function setup() {
  const h = await ordersHarness();
  const order = (await h.createOrder(h.orderBody([lineBody({ quantity: 1 })]))).body as {
    id: string;
    lines: { id: string }[];
  };
  const edit = (quantity: number, version: number) =>
    h.editOrder(
      order.id,
      h.orderBody([{ ...lineBody({ quantity }), id: order.lines[0]?.id }]),
      version,
    );
  expect((await edit(2, 1)).status).toBe(200);
  expect((await edit(3, 2)).status).toBe(200);
  return { h, order };
}

describe('[NFR-AUD-03] the order timeline', () => {
  it('[NFR-AUD-03] the owner reads it newest first, paginated, with actor, capacity, time and details', async () => {
    const { h, order } = await setup();
    const res = await timeline(h, order.id);
    expect(res.status).toBe(200);
    const body = res.body as Timeline;
    expect(body.total).toBe(3);
    expect(body.items.map((i) => i.action)).toEqual(['PO_EDITED', 'PO_EDITED', 'PO_CREATED']);
    expect(body.items[0]).toMatchObject({
      actor: { type: 'USER', name: 'Bea Buyer', email: h.buyer.email, role: 'BUYER' },
      details: { total: { before: '25.0000', after: '37.5000' } },
    });
    expect(body.items[0]?.occurredAt).toMatch(/Z$/);
    const second = (await timeline(h, order.id, h.jar, '?pageSize=1&page=2')).body as Timeline;
    expect(second).toMatchObject({ total: 3 });
    expect(second.items.map((i) => i.id)).toEqual([body.items[1]?.id]);
  });

  it('[NFR-AUD-03] an Admin reads it; another Buyer and an Approver get 404', async () => {
    const { h, order } = await setup();
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    expect(((await timeline(h, order.id, admin)).body as Timeline).total).toBe(3);
    for (const roles of ['{BUYER}', '{APPROVER}']) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await timeline(h, order.id, jar);
      expect(res.status, roles).toBe(404);
      expect(res.body, roles).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('[NFR-AUD-03] an id that never was an order is 404, even for an Admin; a malformed one 400', async () => {
    const { h } = await setup();
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const missing = await timeline(h, randomUUID(), admin);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
    const malformed = await timeline(h, 'not-a-uuid', admin);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      details: [{ path: 'path.id', code: 'INVALID_FORMAT' }],
    });
  });
});
