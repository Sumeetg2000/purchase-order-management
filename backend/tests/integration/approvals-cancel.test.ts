import { DECISION_REASON_MAX, type Order } from '@po/contracts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ordersHarness, type OrdersHarness } from '../support/orders.js';

// Cancel through the API (US1, FR-001–FR-005, FR-016; research R3, R5, R7): an Approver
// cancels an approved order they don't own, with a reason and its version; the order is
// CANCELLED (T10), final, and one PO_CANCELLED records the lines.

const reason = { reason: 'Supplier closed' };

/** An order approved by Priya's step decision (₹1,50,000, above the seeded tier): version 3. */
async function stepApproved() {
  const h = await ordersHarness();
  const draft = await h.draftAt('150000');
  await h.submitOrder(draft.id, 1);
  const priya = await h.approver();
  await h.approveOrder(draft.id, 2, priya.jar);
  return { h, id: draft.id, priya, version: 3 };
}

async function deactivateVendor(h: OrdersHarness) {
  await h.query('BEGIN');
  await h.query('SET LOCAL session_replication_role = replica');
  await h.query(`UPDATE vendors SET status = 'INACTIVE', deactivated_at = now() WHERE id = $1`, [
    h.vendorId,
  ]);
  await h.query('COMMIT');
}

const cancels = async (h: OrdersHarness) =>
  (await h.orderAudit()).filter((e) => e.action === 'PO_CANCELLED');

describe('[FR-LCK-02] cancel an approved order', () => {
  it('[FR-LCK-02] → CANCELLED: version up, the cancellation named, one PO_CANCELLED with the lines', async () => {
    const { h, id, priya, version } = await stepApproved();
    const res = await h.cancelOrder(id, version, priya.jar, reason);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe('"4"');
    expect(res.body).toMatchObject({
      status: 'CANCELLED',
      version: 4,
      approval: { outcome: 'APPROVED' },
      cancellation: {
        cancelledBy: { id: priya.id, name: 'Priya Approver' },
        reason: 'Supplier closed',
      },
    });
    const line = (res.body as Order).lines[0];
    expect(await cancels(h)).toEqual([
      expect.objectContaining({
        actor_type: 'USER',
        actor_user_id: priya.id,
        acting_role: 'APPROVER',
        details: {
          round: 1,
          reason: 'Supplier closed',
          lines: [{ lineId: line?.id, position: 0, quantity: 1, receivedQuantity: 0 }],
        },
      }),
    ]);
  });

  it('[FR-LCK-02] an order the submit auto-approved (SYSTEM) is cancelled the same way', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('10');
    await h.submitOrder(draft.id, 1);
    const priya = await h.approver();
    const res = await h.cancelOrder(draft.id, 2, priya.jar, reason);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', approval: { outcome: 'AUTO_APPROVED' } });
  });

  it('[FR-VEN-02] the vendor deactivated after approval: the cancel succeeds', async () => {
    const { h, id, priya, version } = await stepApproved();
    await deactivateVendor(h);
    expect((await h.cancelOrder(id, version, priya.jar, reason)).status).toBe(200);
  });

  it('[FR-ACT-01] the owner deactivated, or no longer a Buyer: the cancel succeeds, closing the order', async () => {
    for (const change of [{ status: 'DEACTIVATED' }, { roles: '{}' }] as const) {
      const { h, id, priya, version } = await stepApproved();
      await h.setUser(h.buyer.id, change);
      const res = await h.cancelOrder(id, version, priya.jar, reason);
      expect(res.status, JSON.stringify(change)).toBe(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', ownerCanAct: false });
    }
  });

  it('[NFR-VAL-01] a reason is required: missing, empty, blank or too long is refused at the field', async () => {
    const { h, id, priya, version } = await stepApproved();
    const field = async (body: unknown) =>
      (
        (await h.cancelOrder(id, version, priya.jar, body)).body as {
          details?: { path: string; code: string }[];
        }
      ).details?.[0];
    expect(await field({})).toEqual({ path: 'body.reason', code: 'REQUIRED' });
    expect(await field({ reason: '' })).toMatchObject({ code: 'TOO_SHORT' });
    expect(await field({ reason: '   ' })).toMatchObject({ code: 'TOO_SHORT' });
    expect(await field({ reason: 'x'.repeat(DECISION_REASON_MAX + 1) })).toMatchObject({
      code: 'TOO_LONG',
    });
    expect(await field({ ...reason, status: 'CANCELLED' })).toEqual({
      path: 'body.status',
      code: 'UNKNOWN_FIELD',
    });
    expect(await cancels(h)).toEqual([]);
    expect(((await h.getOrder(id)).body as Order).status).toBe('APPROVED');
  });

  it('[NFR-CON-03] the version is required and must match; nothing changes otherwise', async () => {
    const { h, id, priya, version } = await stepApproved();
    const missing = await h.cancelOrder(id, null, priya.jar, reason);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ details: [{ code: 'VERSION_REQUIRED' }] });
    const stale = await h.cancelOrder(id, version - 1, priya.jar, reason);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await cancels(h)).toEqual([]);
    expect(((await h.getOrder(id)).body as Order).version).toBe(version);
  });

  it('[FR-LCK-02] an order that does not exist is 404, an id that is not one 400', async () => {
    const { h, priya } = await stepApproved();
    expect((await h.cancelOrder(randomUUID(), 1, priya.jar, reason)).status).toBe(404);
    const invalid = await h.cancelOrder('not-an-id', 1, priya.jar, reason);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('[FR-SM-01] cancel starts only from APPROVED (T10)', () => {
  it('[FR-SM-01] pending, rejected and cancelled orders: 409 INVALID_STATE_TRANSITION, action CANCEL', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    const pending = await h.draftAt('150000');
    await h.submitOrder(pending.id, 1);
    const rejected = await h.draftAt('150000');
    await h.submitOrder(rejected.id, 1);
    await h.rejectOrder(rejected.id, 2, priya.jar, reason);
    const cancelled = await h.draftAt('10');
    await h.submitOrder(cancelled.id, 1);
    await h.cancelOrder(cancelled.id, 2, priya.jar, reason);
    for (const [status, id, version] of [
      ['PENDING_APPROVAL', pending.id, 2],
      ['REJECTED', rejected.id, 3],
      ['CANCELLED', cancelled.id, 3],
    ] as const) {
      const res = await h.cancelOrder(id, version, priya.jar, reason);
      expect(res.status, status).toBe(409);
      expect(res.body, status).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        orderState: { status, action: 'CANCEL' },
      });
    }
    expect(await cancels(h)).toHaveLength(1);
  });

  it("[FR-SM-01] a draft is another buyer's and unreadable to an Approver: 404", async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    const draft = await h.draftAt('10');
    expect((await h.cancelOrder(draft.id, 1, priya.jar, reason)).status).toBe(404);
  });
});
