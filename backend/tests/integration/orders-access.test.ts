import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN } from '../support/accounts.js';
import { lineBody, ordersHarness } from '../support/orders.js';

// Draft-order visibility and role boundaries (spec US6, ADR-0004): no role and no session
// are refused before validation; a Buyer+Approver acts on their own draft as its owner;
// losing the Buyer role refuses the next save, and the orders stay.

describe('[FR-OWN-01] draft order role boundaries', () => {
  it('[NFR-AUTH-01] no role is 403 NO_ROLE_ASSIGNED on every order route, even with an invalid body', async () => {
    const h = await ordersHarness();
    const id = ((await h.createOrder(h.orderBody())).body as { id: string }).id;
    const jar = await h.loggedIn(await h.seedUser({ roles: '{}' }));
    for (const res of [
      await h.getOrder(id, jar),
      await h.createOrder({ bogus: 1 }, { as: jar, key: null }),
      await h.editOrder(id, { bogus: 1 }, null, jar),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'NO_ROLE_ASSIGNED' });
    }
  });

  it('[NFR-AUTH-01] no session is 401 on every order route, before anything is read', async () => {
    const h = await ordersHarness();
    const id = ((await h.createOrder(h.orderBody())).body as { id: string }).id;
    for (const res of [
      await request(h.app).get(`/orders/${id}`),
      await request(h.app).post('/orders').set('Origin', APP_ORIGIN).send({ bogus: 1 }),
      await request(h.app).patch(`/orders/${id}`).set('Origin', APP_ORIGIN).send({ bogus: 1 }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('[FR-OWN-01] a Buyer+Approver raises, reads and edits their own draft as its owner', async () => {
    const h = await ordersHarness();
    const both = await h.seedUser({ roles: '{BUYER,APPROVER}' });
    const jar = await h.loggedIn(both);
    const created = await h.createOrder(h.orderBody([lineBody({ quantity: 1 })]), { as: jar });
    expect(created.status).toBe(201);
    const order = created.body as { id: string; lines: { id: string }[] };
    expect((await h.getOrder(order.id, jar)).status).toBe(200);
    const edited = await h.editOrder(
      order.id,
      h.orderBody([{ ...lineBody({ quantity: 2 }), id: order.lines[0]?.id }]),
      1,
      jar,
    );
    expect(edited.status).toBe(200);
    const [entry] = (await h.orderAudit()).filter((e) => e.action === 'PO_EDITED');
    expect(entry).toMatchObject({ actor_user_id: both.id, acting_role: 'BUYER' });
  });

  it('[FR-OWN-01] a Buyer who loses the Buyer role mid-edit is refused the save; the order stays', async () => {
    const h = await ordersHarness();
    const order = (await h.createOrder(h.orderBody())).body as {
      id: string;
      lines: { id: string }[];
    };
    const body = h.orderBody([{ ...lineBody({ quantity: 2 }), id: order.lines[0]?.id }]);
    // Roles are read on every request (ADR-0017); changed here without ending the session.
    const setRoles = async (roles: string) => {
      await h.query('BEGIN');
      await h.query('SET LOCAL session_replication_role = replica');
      await h.query(`UPDATE users SET roles = $2::text[] WHERE id = $1`, [h.buyer.id, roles]);
      await h.query('COMMIT');
    };
    await setRoles('{APPROVER}');
    const approverNow = await h.editOrder(order.id, body, 1);
    expect(approverNow.status).toBe(403);
    expect(approverNow.body).toMatchObject({ code: 'FORBIDDEN' });
    await setRoles('{}');
    const noRole = await h.editOrder(order.id, body, 1);
    expect(noRole.status).toBe(403);
    expect(noRole.body).toMatchObject({ code: 'NO_ROLE_ASSIGNED' });
    const [row] = await h.query<{ version: number }>(
      `SELECT version FROM purchase_orders WHERE id = $1`,
      [order.id],
    );
    expect(row?.version).toBe(1);
  });

  it('[FR-OWN-01] another Buyer cannot read, edit or learn of a draft: 404 every time', async () => {
    const h = await ordersHarness();
    const order = (await h.createOrder(h.orderBody())).body as {
      id: string;
      lines: { id: string }[];
    };
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));
    const unknown = randomUUID();
    for (const id of [order.id, unknown]) {
      const read = await h.getOrder(id, other);
      const edit = await h.editOrder(id, h.orderBody([lineBody()]), 1, other);
      expect([read.status, edit.status], id).toEqual([404, 404]);
      expect(read.body).toEqual({ ...(read.body as object), code: 'NOT_FOUND' });
    }
  });
});
