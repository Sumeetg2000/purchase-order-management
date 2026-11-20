import { DECISION_REASON_MAX, NOT_ORDER_OWNER_DETAIL, type Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { lineBody, ordersHarness } from '../support/orders.js';

// Withdraw, change and resubmit (US5, FR-012, FR-APR-02; research R2): the owner takes a
// pending order back to DRAFT with a reason; the round's steps are voided, an earlier
// approval kept; an edit and a resubmit open round 2, routed afresh.

const reason = { reason: 'Wrong quantity' };

describe('[FR-APR-02] withdraw a pending order', () => {
  it('[FR-APR-02] → DRAFT: steps voided, round WITHDRAWN with the reason, editable again; resubmit re-routes', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    await h.submitOrder(draft.id, 1);
    const res = await h.withdrawOrder(draft.id, 2, h.jar, reason);
    expect(res.status).toBe(200);
    const withdrawn = res.body as Order;
    expect(withdrawn).toMatchObject({
      status: 'DRAFT',
      version: 3,
      submittedAt: null,
      vendorSnapshot: null,
      approval: {
        round: 1,
        outcome: 'WITHDRAWN',
        withdrawReason: 'Wrong quantity',
        steps: [{ state: 'VOIDED' }],
      },
    });
    // Edit it under the threshold and resubmit: auto-approved, round 2.
    const edit = await h.editOrder(
      draft.id,
      h.orderBody([lineBody({ id: withdrawn.lines[0]?.id, quantity: 1, unitPrice: '90000' })]),
      3,
    );
    expect(edit.status).toBe(200);
    const resubmitted = (await h.submitOrder(draft.id, 4)).body as Order;
    expect(resubmitted).toMatchObject({
      status: 'APPROVED',
      approval: { round: 2, outcome: 'AUTO_APPROVED', steps: [] },
      vendorSnapshot: { name: 'Acme Supplies' },
    });
    const timeline = (await h.orderAudit()).map((e) => e.action);
    expect(timeline).toEqual([
      'PO_CREATED',
      'PO_SUBMITTED',
      'PO_WITHDRAWN',
      'PO_EDITED',
      'PO_SUBMITTED',
      'PO_AUTO_APPROVED',
    ]);
  });

  it('[FR-SM-03] an approval of an earlier step is voided but keeps who approved it', async () => {
    const h = await ordersHarness();
    await h.addPolicy(2, ['100000', '1000000']);
    const draft = await h.draftAt('2000000');
    await h.submitOrder(draft.id, 1);
    const priya = await h.approver();
    await h.approveOrder(draft.id, 2, priya.jar);
    const res = await h.withdrawOrder(draft.id, 3, h.jar, reason);
    expect(res.body).toMatchObject({
      approval: {
        steps: [
          { state: 'VOIDED', decidedBy: { id: priya.id } },
          { state: 'VOIDED', decidedBy: null },
        ],
      },
    });
    const [entry] = (await h.orderAudit()).filter((e) => e.action === 'PO_WITHDRAWN');
    expect(entry).toMatchObject({
      actor_user_id: h.buyer.id,
      acting_role: 'BUYER',
      details: {
        round: 1,
        reason: 'Wrong quantity',
        voidedSteps: [
          {
            step: 1,
            tier: 1,
            earlierDecision: { by: { id: priya.id, name: 'Priya Approver' }, version: 2 },
          },
          { step: 2, tier: 2, earlierDecision: null },
        ],
      },
    });
  });

  it('[NFR-VAL-01] the reason is required; If-Match must be current; only a pending order', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    expect((await h.withdrawOrder(draft.id, 1, h.jar, reason)).body).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      orderState: { status: 'DRAFT', action: 'WITHDRAW' },
    });
    await h.submitOrder(draft.id, 1);
    const details = async (body: unknown) =>
      ((await h.withdrawOrder(draft.id, 2, h.jar, body)).body as { details?: { code: string }[] })
        .details?.[0]?.code;
    expect(await details({})).toBe('REQUIRED');
    expect(await details({ reason: 'x'.repeat(DECISION_REASON_MAX + 1) })).toBe('TOO_LONG');
    expect((await h.withdrawOrder(draft.id, 1, h.jar, reason)).body).toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect((await h.withdrawOrder(draft.id, null, h.jar, reason)).body).toMatchObject({
      details: [{ code: 'VERSION_REQUIRED' }],
    });
  });

  it('[FR-OWN-01] who may withdraw: another Buyer 404, a Buyer+Approver NOT_ORDER_OWNER, an Approver after it 404', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    await h.submitOrder(draft.id, 1);
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));
    expect((await h.withdrawOrder(draft.id, 2, other, reason)).status).toBe(404);
    const both = await h.approver('{BUYER,APPROVER}', 'Dev Dual');
    const res = await h.withdrawOrder(draft.id, 2, both.jar, reason);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'NOT_ORDER_OWNER', detail: NOT_ORDER_OWNER_DETAIL });
    await h.withdrawOrder(draft.id, 2, h.jar, reason);
    // A draft again: unreadable to an Approver, timeline included (ADR-0004 S7).
    const priya = await h.approver();
    expect((await h.getOrder(draft.id, priya.jar)).status).toBe(404);
    expect((await h.get(`/orders/${draft.id}/timeline`, priya.jar)).status).toBe(404);
  });
});
