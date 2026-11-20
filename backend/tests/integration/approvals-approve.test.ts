import {
  ORDER_ADMIN_READ_ONLY_MESSAGE,
  ORDER_DECISION_APPROVER_ONLY_MESSAGE,
  ORDER_OWNER_INACTIVE_DETAIL,
  SELF_APPROVAL_DETAIL,
  type Order,
} from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { ordersHarness } from '../support/orders.js';

// Approve through the API (US3, FR-010, FR-013; research R6, R8): the current step, bound
// to the version; T6 or T7; every refusal with its code, in ADR-0004's precedence.

async function pending(price = '200000') {
  const h = await ordersHarness();
  const draft = await h.draftAt(price);
  const submitted = (await h.submitOrder(draft.id, 1)).body as Order;
  const priya = await h.approver();
  return { h, id: draft.id, version: submitted.version, priya };
}

async function deactivateVendor(h: Awaited<ReturnType<typeof ordersHarness>>) {
  await h.query('BEGIN');
  await h.query('SET LOCAL session_replication_role = replica');
  await h.query(`UPDATE vendors SET status = 'INACTIVE', deactivated_at = now() WHERE id = $1`, [
    h.vendorId,
  ]);
  await h.query('COMMIT');
}

describe('[FR-APR-01] approve the current step', () => {
  it('[FR-SM-01] a one-step chain: the order is APPROVED (T7), bound to the version approved', async () => {
    const { h, id, version, priya } = await pending();
    const res = await h.approveOrder(id, version, priya.jar);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe(`"${String(version + 1)}"`);
    const order = res.body as Order;
    expect(order).toMatchObject({
      status: 'APPROVED',
      version: version + 1,
      approval: {
        outcome: 'APPROVED',
        steps: [{ state: 'APPROVED', decidedBy: { id: priya.id, name: 'Priya Approver' } }],
      },
    });
    expect(order.approvedAt).toBe(order.approval?.closedAt);
    const [step] = await h.query<{ decided_version: number }>(
      `SELECT decided_version FROM approval_steps WHERE order_id = $1`,
      [id],
    );
    expect(step?.decided_version).toBe(version);
  });

  it('[FR-APR-03] a two-step chain: step 1 keeps it pending (T6), step 2 approves it (T7)', async () => {
    const h = await ordersHarness();
    await h.addPolicy(2, ['100000', '1000000']);
    const draft = await h.draftAt('2000000');
    await h.submitOrder(draft.id, 1);
    const priya = await h.approver();
    const first = await h.approveOrder(draft.id, 2, priya.jar);
    expect(first.body).toMatchObject({
      status: 'PENDING_APPROVAL',
      version: 3,
      approval: { outcome: null, steps: [{ state: 'APPROVED' }, { state: 'OPEN' }] },
    });
    const second = await h.approveOrder(draft.id, 3, priya.jar);
    expect(second.body).toMatchObject({ status: 'APPROVED', version: 4 });
  });

  it('[FR-APR-01] an inactive vendor is 409 VENDOR_INACTIVE and nothing changes', async () => {
    const { h, id, version, priya } = await pending();
    await deactivateVendor(h);
    const res = await h.approveOrder(id, version, priya.jar);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'VENDOR_INACTIVE' });
    expect(((await h.getOrder(id)).body as Order).status).toBe('PENDING_APPROVAL');
  });

  it('[FR-APR-01] an owner deactivated or without BUYER: 409 ORDER_OWNER_INACTIVE; approved once restored', async () => {
    const { h, id, version, priya } = await pending();
    for (const change of [{ status: 'DEACTIVATED' as const }, { roles: '{APPROVER}' }]) {
      await h.setUser(h.buyer.id, change);
      const res = await h.approveOrder(id, version, priya.jar);
      expect(res.status, JSON.stringify(change)).toBe(409);
      expect(res.body).toMatchObject({
        code: 'ORDER_OWNER_INACTIVE',
        detail: ORDER_OWNER_INACTIVE_DETAIL,
      });
      await h.setUser(h.buyer.id, { status: 'ACTIVE', roles: '{BUYER}' });
    }
    // The order says so, to everyone who reads it.
    await h.setUser(h.buyer.id, { status: 'DEACTIVATED' });
    expect(((await h.getOrder(id, priya.jar)).body as Order).ownerCanAct).toBe(false);
    await h.setUser(h.buyer.id, { status: 'ACTIVE' });
    expect((await h.approveOrder(id, version, priya.jar)).body).toMatchObject({
      status: 'APPROVED',
    });
  });

  it('[NFR-CON-03] If-Match is required and must be current; a non-pending order is INVALID_STATE_TRANSITION', async () => {
    const { h, id, version, priya } = await pending();
    expect((await h.approveOrder(id, null, priya.jar)).body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ code: 'VERSION_REQUIRED' }],
    });
    expect((await h.approveOrder(id, version - 1, priya.jar)).body).toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect((await h.approveOrder(id, version, priya.jar, { bogus: 1 })).body).toMatchObject({
      details: [{ path: 'body.bogus', code: 'UNKNOWN_FIELD' }],
    });
    await h.approveOrder(id, version, priya.jar);
    expect((await h.approveOrder(id, version + 1, priya.jar)).body).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      orderState: { status: 'APPROVED', action: 'APPROVE' },
    });
  });

  it('[FR-OWN-01] a draft is 404 to an Approver', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('200000');
    const priya = await h.approver();
    expect((await h.approveOrder(draft.id, 1, priya.jar)).status).toBe(404);
  });
});

describe('[FR-SOD-01] who may approve', () => {
  it('[FR-SOD-01] the owner holding BUYER and APPROVER: 403 SELF_APPROVAL, after 404, before every 409', async () => {
    const h = await ordersHarness();
    await h.setUser(h.buyer.id, { roles: '{BUYER,APPROVER}' });
    const draft = await h.draftAt('200000');
    await h.submitOrder(draft.id, 1);
    // A stale version and an inactive vendor: SELF_APPROVAL still comes first.
    await deactivateVendor(h);
    const res = await h.approveOrder(draft.id, 1, h.jar);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SELF_APPROVAL', detail: SELF_APPROVAL_DETAIL });
    const [row] = await h.query<{ state: string; n: number }>(
      `SELECT s.state, (SELECT count(*)::int FROM audit_entries
                         WHERE order_id = $1 AND action = 'APPROVAL_STEP_APPROVED') AS n
         FROM approval_steps s WHERE s.order_id = $1`,
      [draft.id],
    );
    expect(row).toEqual({ state: 'OPEN', n: 0 });
  });

  it('[FR-ACT-01] a pure Buyer and an Admin are refused at the route, each told why', async () => {
    const { h, id, version } = await pending();
    for (const [roles, detail] of [
      ['{BUYER}', ORDER_DECISION_APPROVER_ONLY_MESSAGE],
      ['{ADMIN}', ORDER_ADMIN_READ_ONLY_MESSAGE],
    ] as const) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.approveOrder(id, version, jar, { bogus: 1 });
      expect(res.status, roles).toBe(403);
      expect(res.body, roles).toMatchObject({ code: 'FORBIDDEN', detail });
    }
  });
});
