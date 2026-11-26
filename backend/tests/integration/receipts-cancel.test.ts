import { describe, expect, it } from 'vitest';
import { indiaDate, receiptBody, receiptsHarness } from '../support/receipts.js';

// Cancelling an order that has received goods (US5, FR-016, FR-017, FR-LCK-02; ADR-0001
// T10, ADR-0011): a partly received order cancels, keeping its receipts, and PO_CANCELLED
// records what each line received; a fully received order is refused (409
// ORDER_FULLY_RECEIVED, after the version check) and nothing changes; a receipt after the
// cancel is refused, and outstanding stays ordered minus received.

const reason = { reason: 'Supplier closed' };

/** An approved order (auto-approved: version 2) of lines 5 and 3, the clock on today. */
async function approved() {
  const h = await receiptsHarness();
  const jar = await h.setClock(new Date());
  const order = await h.approvedOrder([5, 3], jar);
  const priya = await h.approver();
  const [a = '', b = ''] = order.lineIds;
  return { h, priya, today: indiaDate(new Date()), ...order, a, b };
}

async function cancelEntries(h: Awaited<ReturnType<typeof approved>>['h'], id: string) {
  return (await h.orderAudit()).filter((e) => e.action === 'PO_CANCELLED' && e.order_id === id);
}

describe('[FR-LCK-02] cancelling an order with receipts', () => {
  it('[FR-LCK-02] partly received: 200, the receipts kept, PO_CANCELLED records each line received', async () => {
    const { h, priya, today, id, a, b } = await approved();
    await h.recordReceipt(id, receiptBody(today, [{ lineId: a, quantity: 2 }]));
    const res = await h.cancelOrder(id, 2, priya.jar, reason);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', receiptProgress: 'PARTIALLY_RECEIVED' });
    expect(await h.receiptCounts(id)).toEqual({ receipts: 1, lines: 1 });
    const [entry] = await cancelEntries(h, id);
    expect((entry?.details as { lines: unknown[] }).lines).toEqual([
      { lineId: a, position: 0, quantity: 5, receivedQuantity: 2 },
      { lineId: b, position: 1, quantity: 3, receivedQuantity: 0 },
    ]);
  });

  it('[FR-LCK-02] fully received: 409 ORDER_FULLY_RECEIVED; the order, its version and the audit unchanged', async () => {
    const { h, priya, today, id, a, b } = await approved();
    await h.recordReceipt(
      id,
      receiptBody(today, [
        { lineId: a, quantity: 5 },
        { lineId: b, quantity: 3 },
      ]),
    );
    const res = await h.cancelOrder(id, 2, priya.jar, reason);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ORDER_FULLY_RECEIVED' });
    expect((await h.getOrder(id)).body).toMatchObject({
      status: 'APPROVED',
      version: 2,
      receiptProgress: 'FULLY_RECEIVED',
    });
    expect(await cancelEntries(h, id)).toEqual([]);
  });

  it('[FR-LCK-02] a stale version on a fully received order is VERSION_CONFLICT: the version check comes first', async () => {
    const { h, priya, today, id, a, b } = await approved();
    await h.recordReceipt(
      id,
      receiptBody(today, [
        { lineId: a, quantity: 5 },
        { lineId: b, quantity: 3 },
      ]),
    );
    const res = await h.cancelOrder(id, 1, priya.jar, reason);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('[FR-LCK-02] a receipt after the cancel is 409 ORDER_NOT_RECEIVABLE; outstanding stays ordered minus received', async () => {
    const { h, priya, today, id, a } = await approved();
    await h.recordReceipt(id, receiptBody(today, [{ lineId: a, quantity: 2 }]));
    await h.cancelOrder(id, 2, priya.jar, reason);
    const res = await h.recordReceipt(id, receiptBody(today, [{ lineId: a, quantity: 1 }]));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'ORDER_NOT_RECEIVABLE',
      orderState: { status: 'CANCELLED' },
    });
    const lines = (
      (await h.getOrder(id)).body as {
        lines: { receivedQuantity: number; outstandingQuantity: number }[];
      }
    ).lines;
    expect(lines.map((l) => [l.receivedQuantity, l.outstandingQuantity])).toEqual([
      [2, 3],
      [0, 3],
    ]);
  });
});
