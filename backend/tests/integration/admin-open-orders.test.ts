import { describe, expect, it } from 'vitest';
import { indiaDate, receiptBody, receiptsHarness } from '../support/receipts.js';

// The Admin sees a user's open orders before changing them (US6, FR-023, FR-ADM-02;
// ADR-0016, ADR-0019): drafts, pending orders, and approved orders with something still to
// receive, on the user detail and on the update's response. Closed orders (rejected,
// cancelled, fully received) don't count.

describe('[FR-ADM-02] open-order counts on the admin user detail', () => {
  it("[FR-ADM-02] the spec's Buyer: 2 drafts, 1 pending, 2 approved with goods to receive", async () => {
    const h = await receiptsHarness();
    const jar = await h.setClock(new Date());
    const today = indiaDate(new Date());
    const priya = await h.approver();
    await h.createOrder(h.orderBody(), { as: jar });
    await h.createOrder(h.orderBody(), { as: jar });
    const pending = await h.draftAt('150000', jar);
    await h.submitOrder(pending.id, 1, jar);
    await h.approvedOrder([5], jar);
    await h.approvedOrder([5], jar);
    const full = await h.approvedOrder([5], jar);
    await h.recordReceipt(
      full.id,
      receiptBody(today, [{ lineId: full.lineIds[0] ?? '', quantity: 5 }]),
    );
    const rejected = await h.draftAt('150000', jar);
    await h.submitOrder(rejected.id, 1, jar);
    await h.rejectOrder(rejected.id, 2, priya.jar, { reason: 'Too costly' });
    const cancelled = await h.approvedOrder([5], jar);
    await h.cancelOrder(cancelled.id, 2, priya.jar, { reason: 'Supplier closed' });

    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const detail = await h.get(`/admin/users/${h.buyer.id}`, admin);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      openOrders: { draft: 2, pending: 1, approvedWithOpenLines: 2 },
    });
    const version = (detail.body as { version: number }).version;
    const updated = await h.send(
      'patch',
      `/admin/users/${h.buyer.id}`,
      admin,
      { roles: ['BUYER', 'APPROVER'] },
      { 'If-Match': `"${String(version)}"` },
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      openOrders: { draft: 2, pending: 1, approvedWithOpenLines: 2 },
    });
  });

  it('[FR-ADM-02] a user with no orders, an Approver and an Admin: all zero', async () => {
    const h = await receiptsHarness();
    const admin = await h.seedUser({ roles: '{ADMIN}' });
    const adminJar = await h.loggedIn(admin);
    const approver = await h.approver();
    const zero = { draft: 0, pending: 0, approvedWithOpenLines: 0 };
    for (const [who, id] of [
      ['a Buyer with no orders', h.buyer.id],
      ['an Approver', approver.id],
      ['an Admin', admin.id],
    ] as const) {
      const res = await h.get(`/admin/users/${id}`, adminJar);
      expect(res.body, who).toMatchObject({ openOrders: zero });
    }
  });
});
