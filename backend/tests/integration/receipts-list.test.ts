import { describe, expect, it } from 'vitest';
import { indiaDate, receiptBody, receiptsHarness } from '../support/receipts.js';

// The list badge (FR-021a; research R9): every order list row carries its receipt
// progress, derived per page row (NOT_RECEIVED unless approved or cancelled; FULLY_RECEIVED
// with no open line; PARTIALLY_RECEIVED with any receipt). Counts and filters are unchanged.

describe('[FR-RCV-01] order list rows carry their receipt progress', () => {
  it('[FR-RCV-01] draft, pending, rejected, approved (nothing, partly, fully), cancelled (with and without receipts)', async () => {
    const h = await receiptsHarness();
    const jar = await h.setClock(new Date());
    const today = indiaDate(new Date());
    const priya = await h.approver();
    const draft = (await h.createOrder(h.orderBody(), { as: jar })).body as { id: string };
    const pending = await h.draftAt('150000', jar);
    await h.submitOrder(pending.id, 1, jar);
    const rejected = await h.draftAt('150000', jar);
    await h.submitOrder(rejected.id, 1, jar);
    await h.rejectOrder(rejected.id, 2, priya.jar, { reason: 'Too costly' });
    const nothing = await h.approvedOrder([5], jar);
    const partly = await h.approvedOrder([5], jar);
    await h.recordReceipt(
      partly.id,
      receiptBody(today, [{ lineId: partly.lineIds[0] ?? '', quantity: 2 }]),
    );
    const fully = await h.approvedOrder([5], jar);
    await h.recordReceipt(
      fully.id,
      receiptBody(today, [{ lineId: fully.lineIds[0] ?? '', quantity: 5 }]),
    );
    const cancelledWith = await h.approvedOrder([5], jar);
    await h.recordReceipt(
      cancelledWith.id,
      receiptBody(today, [{ lineId: cancelledWith.lineIds[0] ?? '', quantity: 1 }]),
    );
    await h.cancelOrder(cancelledWith.id, 2, priya.jar, { reason: 'Supplier closed' });
    const cancelledWithout = await h.approvedOrder([5], jar);
    await h.cancelOrder(cancelledWithout.id, 2, priya.jar, { reason: 'Supplier closed' });

    const res = await h.get('/orders?pageSize=50', jar);
    expect(res.status).toBe(200);
    const body = res.body as { total: number; items: { id: string; receiptProgress: string }[] };
    const progress = Object.fromEntries(body.items.map((i) => [i.id, i.receiptProgress]));
    expect({
      draft: progress[draft.id],
      pending: progress[pending.id],
      rejected: progress[rejected.id],
      nothing: progress[nothing.id],
      partly: progress[partly.id],
      fully: progress[fully.id],
      cancelledWith: progress[cancelledWith.id],
      cancelledWithout: progress[cancelledWithout.id],
    }).toEqual({
      draft: 'NOT_RECEIVED',
      pending: 'NOT_RECEIVED',
      rejected: 'NOT_RECEIVED',
      nothing: 'NOT_RECEIVED',
      partly: 'PARTIALLY_RECEIVED',
      fully: 'FULLY_RECEIVED',
      cancelledWith: 'PARTIALLY_RECEIVED',
      cancelledWithout: 'NOT_RECEIVED',
    });
    // Counts are unchanged: every order the Buyer raised, whatever it received.
    expect(body.total).toBe(8);
    // The Approver's list carries it too.
    const approverList = (await h.get('/orders?pageSize=50', priya.jar)).body as {
      items: { id: string; receiptProgress: string }[];
    };
    expect(approverList.items.find((i) => i.id === fully.id)?.receiptProgress).toBe(
      'FULLY_RECEIVED',
    );
  });
});
