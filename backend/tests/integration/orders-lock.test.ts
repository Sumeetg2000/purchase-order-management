import {
  NOT_ORDER_OWNER_DETAIL,
  ORDER_LOCKED_MESSAGES,
  ORDER_PENDING_APPROVAL_DETAIL,
} from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { lineBody, ordersHarness } from '../support/orders.js';
import { plantSubmitted, type SubmittedStatus } from '../support/orders-sql.js';

// Edits and deletes of a submitted order through the API (slice 4 research R8, FR-007,
// FR-008): a specific 409 per state, with the order's status and the refused action in
// orderState, and NOT_ORDER_OWNER for a Buyer+Approver who can read but doesn't own it.

/** A ₹2,00,000 draft (above the seeded tier), planted into `status`. */
async function submitted(status: SubmittedStatus) {
  const h = await ordersHarness();
  const res = await h.createOrder(h.orderBody([lineBody({ quantity: 2, unitPrice: '100000' })]));
  const order = res.body as { id: string; lines: { id: string }[] };
  await plantSubmitted(h, order.id, status);
  const body = h.orderBody([lineBody({ quantity: 1, unitPrice: '1', id: order.lines[0]?.id })]);
  return { h, id: order.id, body };
}

describe('[FR-LCK-01] edits and deletes of a submitted order', () => {
  it('[FR-APR-02] a pending order: 409 ORDER_PENDING_APPROVAL, telling the owner to withdraw it', async () => {
    const { h, id, body } = await submitted('PENDING_APPROVAL');
    const edit = await h.editOrder(id, body, 2);
    expect(edit.status).toBe(409);
    expect(edit.body).toMatchObject({
      code: 'ORDER_PENDING_APPROVAL',
      detail: ORDER_PENDING_APPROVAL_DETAIL,
      orderState: { status: 'PENDING_APPROVAL', action: 'EDIT' },
    });
    const del = await h.deleteOrder(id, 2);
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({
      code: 'ORDER_PENDING_APPROVAL',
      orderState: { status: 'PENDING_APPROVAL', action: 'DELETE' },
    });
  });

  it('[FR-LCK-01] an approved order: 409 ORDER_LOCKED, "approved and locked"', async () => {
    const { h, id, body } = await submitted('APPROVED');
    for (const res of [await h.editOrder(id, body, 2), await h.deleteOrder(id, 2)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'ORDER_LOCKED',
        detail: ORDER_LOCKED_MESSAGES.APPROVED,
        orderState: { status: 'APPROVED' },
      });
    }
  });

  it('[FR-LCK-01] a rejected order: 409 ORDER_LOCKED, "rejected and is closed"', async () => {
    const { h, id, body } = await submitted('REJECTED');
    for (const res of [await h.editOrder(id, body, 2), await h.deleteOrder(id, 2)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'ORDER_LOCKED',
        detail: ORDER_LOCKED_MESSAGES.REJECTED,
        orderState: { status: 'REJECTED' },
      });
    }
  });

  it('[FR-LCK-01] the state comes before the version: a stale tab learns the order is locked', async () => {
    const { h, id, body } = await submitted('APPROVED');
    expect((await h.editOrder(id, body, 1)).body).toMatchObject({ code: 'ORDER_LOCKED' });
  });

  it("[FR-OWN-01] a Buyer+Approver editing or deleting another buyer's submitted order: 403 NOT_ORDER_OWNER", async () => {
    const { h, id, body } = await submitted('PENDING_APPROVAL');
    const both = await h.loggedIn(await h.seedUser({ roles: '{BUYER,APPROVER}' }));
    for (const res of [
      await h.editOrder(id, body, 2, both),
      await h.deleteOrder(id, 2, undefined, both),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'NOT_ORDER_OWNER', detail: NOT_ORDER_OWNER_DETAIL });
    }
    // Another buyer's draft stays unreadable to them: 404, before any 403.
    const draft = (await h.createOrder(h.orderBody())).body as { id: string };
    expect((await h.editOrder(draft.id, body, 1, both)).status).toBe(404);
  });

  it('[FR-LCK-01] nothing changed: the order keeps its version, lines and status', async () => {
    const { h, id, body } = await submitted('PENDING_APPROVAL');
    await h.editOrder(id, body, 2);
    await h.deleteOrder(id, 2);
    const [row] = await h.query<{ status: string; version: number; quantity: number }>(
      `SELECT o.status, o.version, l.quantity FROM purchase_orders o
         JOIN order_lines l ON l.order_id = o.id WHERE o.id = $1`,
      [id],
    );
    expect(row).toEqual({ status: 'PENDING_APPROVAL', version: 2, quantity: 2 });
  });
});
