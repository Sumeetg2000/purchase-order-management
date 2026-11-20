import {
  DECISION_REASON_MAX,
  ORDER_LOCKED_MESSAGES,
  SELF_APPROVAL_DETAIL,
  type Order,
} from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { ordersHarness } from '../support/orders.js';

// Reject through the API (US4, FR-011; research R6, R8): a required reason; the order is
// REJECTED (T8) and final; allowed with the vendor inactive or the owner unable to act.

async function pending(price = '200000') {
  const h = await ordersHarness();
  const draft = await h.draftAt(price);
  await h.submitOrder(draft.id, 1);
  const priya = await h.approver();
  return { h, id: draft.id, priya };
}

const reason = { reason: 'Quote too high' };

describe('[FR-SM-03] reject a pending order', () => {
  it('[FR-SM-03] → REJECTED: the step rejected with its reason, the round closed, the order final', async () => {
    const { h, id, priya } = await pending();
    const res = await h.rejectOrder(id, 2, priya.jar, reason);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe('"3"');
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      version: 3,
      approvedAt: null,
      approval: {
        outcome: 'REJECTED',
        steps: [
          {
            state: 'REJECTED',
            decidedBy: { id: priya.id, name: 'Priya Approver' },
            reason: 'Quote too high',
          },
        ],
      },
    });
    // Final: every action is refused, and an edit is ORDER_LOCKED "rejected".
    for (const res2 of [
      await h.submitOrder(id, 3),
      await h.approveOrder(id, 3, priya.jar),
      await h.rejectOrder(id, 3, priya.jar, reason),
      await h.withdrawOrder(id, 3, h.jar, reason),
    ]) {
      expect(res2.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    }
    const draft = (await h.getOrder(id)).body as Order;
    const edit = await h.editOrder(
      id,
      h.orderBody([{ id: draft.lines[0]?.id, description: 'x', quantity: 1, unitPrice: '1' }]),
      3,
    );
    expect(edit.body).toMatchObject({
      code: 'ORDER_LOCKED',
      detail: ORDER_LOCKED_MESSAGES.REJECTED,
    });
  });

  it('[NFR-VAL-01] the reason is required, at most DECISION_REASON_MAX', async () => {
    const { h, id, priya } = await pending();
    const field = async (body: unknown) =>
      ((await h.rejectOrder(id, 2, priya.jar, body)).body as { details?: { code: string }[] })
        .details?.[0]?.code;
    expect(await field(undefined)).toBe('REQUIRED');
    expect(await field({})).toBe('REQUIRED');
    expect(await field({ reason: '   ' })).toBe('TOO_SHORT');
    expect(await field({ reason: 'x'.repeat(DECISION_REASON_MAX + 1) })).toBe('TOO_LONG');
    expect(await field({ reason: 'ok', status: 'REJECTED' })).toBe('UNKNOWN_FIELD');
    expect(((await h.getOrder(id)).body as Order).status).toBe('PENDING_APPROVAL');
  });

  it('[FR-SM-03] allowed with the vendor inactive, and while the owner can no longer act', async () => {
    const { h, id, priya } = await pending();
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(`UPDATE vendors SET status = 'INACTIVE', deactivated_at = now() WHERE id = $1`, [
      h.vendorId,
    ]);
    await h.query('COMMIT');
    await h.setUser(h.buyer.id, { status: 'DEACTIVATED' });
    const res = await h.rejectOrder(id, 2, priya.jar, reason);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'REJECTED' });
  });

  it('[FR-APR-03] a two-step chain: step 1 approved, step 2 rejected; the first keeps its record', async () => {
    const h = await ordersHarness();
    await h.addPolicy(2, ['100000', '1000000']);
    const draft = await h.draftAt('2000000');
    await h.submitOrder(draft.id, 1);
    const priya = await h.approver();
    await h.approveOrder(draft.id, 2, priya.jar);
    const res = await h.rejectOrder(draft.id, 3, priya.jar, reason);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      approval: {
        steps: [
          { state: 'APPROVED', decidedBy: { id: priya.id } },
          { state: 'REJECTED', reason: 'Quote too high' },
        ],
      },
    });
  });

  it('[FR-SOD-01] the owner holding APPROVER: 403 SELF_APPROVAL, nothing changes', async () => {
    const h = await ordersHarness();
    await h.setUser(h.buyer.id, { roles: '{BUYER,APPROVER}' });
    const draft = await h.draftAt('200000');
    await h.submitOrder(draft.id, 1);
    const res = await h.rejectOrder(draft.id, 2, h.jar, reason);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SELF_APPROVAL', detail: SELF_APPROVAL_DETAIL });
  });

  it('[NFR-AUD-01] writes one APPROVAL_STEP_REJECTED as APPROVER with the reason; none on refusal', async () => {
    const { h, id, priya } = await pending();
    await h.rejectOrder(id, 1, priya.jar, reason); // stale
    await h.rejectOrder(id, 2, priya.jar, reason);
    const entries = (await h.orderAudit()).filter((e) => e.action === 'APPROVAL_STEP_REJECTED');
    expect(entries).toEqual([
      expect.objectContaining({
        actor_user_id: priya.id,
        acting_role: 'APPROVER',
        details: { round: 1, step: 1, tier: 1, reason: 'Quote too high' },
      }),
    ]);
  });

  it('[FR-SM-03] a rejected order leaves the queue', async () => {
    const { h, id, priya } = await pending();
    await h.rejectOrder(id, 2, priya.jar, reason);
    expect((await h.listQueue(priya.jar)).body).toMatchObject({ total: 0 });
  });
});
