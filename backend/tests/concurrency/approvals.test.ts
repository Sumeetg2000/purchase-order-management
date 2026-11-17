import type { Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { lineBody, ordersHarness } from '../support/orders.js';

// Submissions under concurrent requests (research R6, FR-017, SC-005). Business outcomes:
// the final status is the routing of the final total; a submit and a vendor deactivation
// or a policy change each end in a state consistent with one order of the two.

describe('[NFR-CON-01] concurrent submissions', () => {
  it('[NFR-CON-01] an edit racing a submit: one wins, the other is 409, and the status routes the final total', async () => {
    const h = await ordersHarness();
    for (let run = 0; run < 5; run += 1) {
      const draft = await h.draftAt('50000');
      // The edit takes the total above the threshold.
      const [edit, submit] = await Promise.all([
        h.editOrder(
          draft.id,
          h.orderBody([lineBody({ id: draft.lines[0]?.id, quantity: 3, unitPrice: '50000' })]),
          1,
        ),
        h.submitOrder(draft.id, 1),
      ]);
      expect([edit.status, submit.status].sort()).toEqual([200, 409]);
      const order = (await h.getOrder(draft.id)).body as Order;
      if (edit.status === 200) {
        expect(order).toMatchObject({ status: 'DRAFT', total: '150000.0000' });
      } else {
        expect(order).toMatchObject({ status: 'APPROVED', total: '50000.0000' });
      }
    }
  });

  it('[NFR-CON-01] a submit racing a vendor deactivation: submitted before it, or VENDOR_INACTIVE after', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    const vendor = (await h.get(`/vendors/${h.vendorId}`, h.jar)).body as { version: number };
    const [submit, deactivate] = await Promise.all([
      h.submitOrder(draft.id, 1),
      h.send('post', `/vendors/${h.vendorId}/deactivate`, h.jar, undefined, {
        'If-Match': `"${String(vendor.version)}"`,
      }),
    ]);
    expect(deactivate.status).toBe(200);
    const order = (await h.getOrder(draft.id)).body as Order;
    if (submit.status === 200) {
      expect(order.status).toBe('PENDING_APPROVAL');
    } else {
      expect(submit.body).toMatchObject({ code: 'VENDOR_INACTIVE' });
      expect(order.status).toBe('DRAFT');
    }
  });

  it('[NFR-CON-01] a submit racing a policy change routes by the version it recorded', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    const setPolicy = async () => {
      await h.query('BEGIN');
      await h.query(`SELECT set_config('app.actor_txid', txid_current()::text, true),
                            set_config('app.actor_type', 'OPERATOR', true),
                            set_config('app.os_user', 'tester', true),
                            set_config('app.os_host', 'ci', true)`);
      await h.query(`SELECT set_approval_policy('{200000}')`);
      await h.query('COMMIT');
    };
    const [submit] = await Promise.all([h.submitOrder(draft.id, 1), setPolicy()]);
    const order = submit.body as Order;
    expect(submit.status).toBe(200);
    // Version 1 needs one step for ₹1,50,000; version 2 none.
    expect(
      order.approval?.policyVersion === 1
        ? order.status === 'PENDING_APPROVAL'
        : order.status === 'APPROVED',
    ).toBe(true);
  });
});
