import type { ApprovalQueueItem, Page } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { ordersHarness } from '../support/orders.js';

// The approval queue (FR-014, ADR-0004 S1, research R7): pending orders the caller may
// approve, never their own, oldest submission first; its total is the nav count.

type Queue = Page<ApprovalQueueItem>;

async function setup() {
  const h = await ordersHarness();
  const submit = async (price: string, as = h.jar) => {
    const draft = await h.draftAt(price, as);
    await h.submitOrder(draft.id, 1, as);
    return draft.id;
  };
  return { h, submit };
}

describe('[FR-OWN-01] the approval queue', () => {
  it('[FR-OWN-01] lists pending orders oldest submission first, each with buyer, vendor, total, step and owner state', async () => {
    const { h, submit } = await setup();
    const first = await submit('150000');
    const second = await submit('300000');
    await submit('10'); // auto-approved: never in the queue
    await h.draftAt('500000'); // a draft: never in the queue
    const priya = await h.approver();
    const queue = (await h.listQueue(priya.jar)).body as Queue;
    expect(queue.total).toBe(2);
    expect(queue.items.map((i) => i.id)).toEqual([first, second]);
    expect(queue.items[0]).toMatchObject({
      owner: { id: h.buyer.id, name: 'Bea Buyer' },
      vendor: { id: h.vendorId, name: 'Acme Supplies' },
      total: '150000.0000',
      currentStep: { step: 1, tier: 1, of: 1 },
      ownerCanAct: true,
      version: 2,
    });
  });

  it('[FR-SOD-01] a Buyer+Approver never sees their own pending order; it is in their order list', async () => {
    const { h, submit } = await setup();
    const others = await submit('150000');
    const both = await h.approver('{BUYER,APPROVER}', 'Dev Dual');
    const own = await submit('150000', both.jar);
    const queue = (await h.listQueue(both.jar)).body as Queue;
    expect(queue.items.map((i) => i.id)).toEqual([others]);
    expect(queue.total).toBe(1);
    const list = (await h.get('/orders', both.jar)).body as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toContain(own);
  });

  it('[FR-OWN-01] filters by vendor, and by PO-number prefix sorted by PO number, newest first', async () => {
    const { h, submit } = await setup();
    const a = await submit('150000');
    const b = await submit('150000');
    const priya = await h.approver();
    const beta = await h.seedVendor({ name: 'Beta Traders' });
    expect(((await h.listQueue(priya.jar, { vendorId: beta })).body as Queue).total).toBe(0);
    expect(
      ((await h.listQueue(priya.jar, { vendorId: h.vendorId })).body as Queue).items.map(
        (i) => i.id,
      ),
    ).toEqual([a, b]);
    const prefix = ((await h.getOrder(a)).body as { poNumber: string }).poNumber.slice(0, 11);
    const byNumber = (await h.listQueue(priya.jar, { poNumber: prefix.toLowerCase() }))
      .body as Queue;
    expect(byNumber.items.map((i) => i.id)).toEqual([b, a]);
  });

  it('[FR-APR-01] marks an order whose owner can no longer act', async () => {
    const { h, submit } = await setup();
    await submit('150000');
    await h.setUser(h.buyer.id, { status: 'DEACTIVATED' });
    const priya = await h.approver();
    const queue = (await h.listQueue(priya.jar)).body as Queue;
    expect(queue.items[0]?.ownerCanAct).toBe(false);
  });

  it('[NFR-FE-08] the nav count is the total of a one-item page', async () => {
    const { h, submit } = await setup();
    for (let i = 0; i < 3; i += 1) await submit('150000');
    const priya = await h.approver();
    const page = (await h.listQueue(priya.jar, { pageSize: 1 })).body as Queue;
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('[NFR-AUTH-02] Buyers and Admins are refused at the route; no role is NO_ROLE_ASSIGNED', async () => {
    const { h } = await setup();
    for (const roles of ['{BUYER}', '{ADMIN}']) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.listQueue(jar);
      expect(res.status, roles).toBe(403);
      expect(res.body, roles).toMatchObject({ code: 'FORBIDDEN' });
    }
    const none = await h.loggedIn(await h.seedUser({ roles: '{}' }));
    expect((await h.listQueue(none)).body).toMatchObject({ code: 'NO_ROLE_ASSIGNED' });
  });
});
