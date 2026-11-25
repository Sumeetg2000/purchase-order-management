import { describe, expect, it } from 'vitest';
import {
  indiaHalfPastMidnight,
  receiptBody,
  receiptsHarness,
  type ReceiptsHarness,
} from '../support/receipts.js';

// Reading receipts (US1, FR-005, FR-021, FR-RCV-03; research R7, R8): the order shows each
// line's received and outstanding quantities and its receipt progress; the history lists
// receipt summaries newest first with their line counts; one receipt's lines are read on
// their own. Whoever can read the order reads its receipts; anyone else gets 404.

interface OrderRead {
  receiptProgress: string;
  receivedLines: { complete: number; partly: number; total: number };
  lines: { id: string; quantity: number; receivedQuantity: number; outstandingQuantity: number }[];
}

/** An approved order of three lines (100, 5, 8), the clock at 00:30 India on its approval day. */
async function threeLines() {
  const h = await receiptsHarness();
  const order = await h.approvedOrder([100, 5, 8]);
  const jar = await h.setClock(indiaHalfPastMidnight(order.approvedOn));
  const [a = '', b = '', c = ''] = order.lineIds;
  return { h, jar, ...order, a, b, c };
}

async function read(h: ReceiptsHarness, id: string) {
  return (await h.getOrder(id)).body as OrderRead;
}

/** Two receipts in one transaction as the Buyer: the same recorded_at, so the id decides. */
async function twoReceiptsAtOnce(h: ReceiptsHarness, orderId: string, lineId: string) {
  await h.query('BEGIN');
  await h.query(
    `SELECT set_config('app.actor_txid', txid_current()::text, true),
            set_config('app.actor_type', 'USER', true),
            set_config('app.actor_user_id', $1, true),
            set_config('app.actor_name', 'Bea Buyer', true),
            set_config('app.actor_email', 'bea@example.local', true),
            set_config('app.acting_role', 'BUYER', true)`,
    [h.buyer.id],
  );
  for (let i = 0; i < 2; i += 1) {
    await h.query(
      `WITH r AS (
         INSERT INTO goods_receipts (order_id, received_on, recorded_by)
         SELECT o.id, (o.approved_at AT TIME ZONE 'Asia/Kolkata')::date, o.owner_id
           FROM purchase_orders o WHERE o.id = $1
         RETURNING id, order_id
       )
       INSERT INTO goods_receipt_lines (receipt_id, order_id, line_id, quantity)
       SELECT id, order_id, $2, 1 FROM r`,
      [orderId, lineId],
    );
  }
  await h.query('COMMIT');
}

describe('[FR-RCV-01] the order shows what was received', () => {
  it('[FR-RCV-01] a draft or an approved order with nothing received: NOT_RECEIVED, all outstanding', async () => {
    const { h, jar, id } = await threeLines();
    const order = await read(h, id);
    expect(order.receiptProgress).toBe('NOT_RECEIVED');
    expect(order.receivedLines).toEqual({ complete: 0, partly: 0, total: 3 });
    expect(order.lines.map((l) => [l.receivedQuantity, l.outstandingQuantity])).toEqual([
      [0, 100],
      [0, 5],
      [0, 8],
    ]);
    const draft = (await h.createOrder(h.orderBody(), { as: jar })).body as { id: string };
    expect(await read(h, draft.id)).toMatchObject({
      receiptProgress: 'NOT_RECEIVED',
      receivedLines: { complete: 0, partly: 0, total: 1 },
    });
  });

  it('[FR-RCV-01] partly received: per-line quantities and the complete and partly counts', async () => {
    const { h, id, a, b, approvedOn } = await threeLines();
    await h.recordReceipt(
      id,
      receiptBody(approvedOn, [
        { lineId: a, quantity: 40 },
        { lineId: b, quantity: 5 },
      ]),
    );
    const order = await read(h, id);
    expect(order.receiptProgress).toBe('PARTIALLY_RECEIVED');
    expect(order.receivedLines).toEqual({ complete: 1, partly: 1, total: 3 });
    expect(order.lines.map((l) => [l.receivedQuantity, l.outstandingQuantity])).toEqual([
      [40, 60],
      [5, 0],
      [0, 8],
    ]);
  });

  it('[FR-RCV-01] fully received: FULLY_RECEIVED, every line complete, still APPROVED', async () => {
    const { h, id, a, b, c, approvedOn } = await threeLines();
    await h.recordReceipt(
      id,
      receiptBody(approvedOn, [
        { lineId: a, quantity: 100 },
        { lineId: b, quantity: 5 },
        { lineId: c, quantity: 8 },
      ]),
    );
    expect(await read(h, id)).toMatchObject({
      status: 'APPROVED',
      receiptProgress: 'FULLY_RECEIVED',
      receivedLines: { complete: 3, partly: 0, total: 3 },
    });
  });
});

describe('[FR-RCV-03] the receipt history', () => {
  it('[FR-RCV-03] receipt summaries newest first, each with its line count and recorder', async () => {
    const { h, id, a, b, c, approvedOn } = await threeLines();
    const first = await h.recordReceipt(
      id,
      receiptBody(approvedOn, [
        { lineId: c, quantity: 1 },
        { lineId: a, quantity: 10 },
        { lineId: b, quantity: 1 },
      ]),
    );
    h.clock.advance(60_000);
    const second = await h.recordReceipt(
      id,
      receiptBody(approvedOn, [{ lineId: a, quantity: 5 }], { note: 'Second van' }),
    );
    const page = await h.listReceipts(id);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    const items = (page.body as { items: Record<string, unknown>[] }).items;
    expect(items.map((r) => [r['id'], r['lineCount'], r['note']])).toEqual([
      [(second.body as { id: string }).id, 1, 'Second van'],
      [(first.body as { id: string }).id, 3, null],
    ]);
    expect(items[0]).toMatchObject({
      receivedOn: approvedOn,
      recordedBy: { id: h.buyer.id, name: 'Bea Buyer' },
    });
    expect(items[0]).not.toHaveProperty('lines');
  });

  it("[FR-RCV-03] one receipt: its lines in position order, with each line's description", async () => {
    const { h, id, a, c, approvedOn } = await threeLines();
    const res = await h.recordReceipt(
      id,
      receiptBody(approvedOn, [
        { lineId: c, quantity: 2 },
        { lineId: a, quantity: 10 },
      ]),
    );
    const receiptId = (res.body as { id: string }).id;
    const detail = await h.getReceipt(id, receiptId);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: receiptId,
      receivedOn: approvedOn,
      recordedBy: { id: h.buyer.id, name: 'Bea Buyer' },
      note: null,
      lines: [
        { line: { id: a, position: 0, description: 'Hex bolts M8' }, quantity: 10 },
        { line: { id: c, position: 2, description: 'Hex bolts M8' }, quantity: 2 },
      ],
    });
  });

  it('[FR-RCV-03] equal recorded times are ordered by id, newest first; pages cut receipts', async () => {
    const { h, id, a } = await threeLines();
    await twoReceiptsAtOnce(h, id, a);
    const all = (await h.listReceipts(id)).body as { items: { id: string; recordedAt: string }[] };
    expect(all.items).toHaveLength(2);
    expect(all.items[0]?.recordedAt).toBe(all.items[1]?.recordedAt);
    expect(all.items.map((r) => r.id)).toEqual(
      all.items
        .map((r) => r.id)
        .sort()
        .reverse(),
    );
    const second = (await h.listReceipts(id, undefined, '?page=2&pageSize=1')).body as {
      items: { id: string }[];
      total: number;
    };
    expect(second.total).toBe(2);
    expect(second.items.map((r) => r.id)).toEqual([all.items[1]?.id]);
  });

  it('[FR-RCV-03] an Approver and an Admin read the receipts; another Buyer gets 404', async () => {
    const { h, id, a, approvedOn } = await threeLines();
    const res = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId: a, quantity: 1 }]));
    const receiptId = (res.body as { id: string }).id;
    const priya = await h.approver();
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}', name: 'Other Buyer' }));
    for (const [who, jar, status] of [
      ['approver', priya.jar, 200],
      ['admin', admin, 200],
      ['other buyer', other, 404],
    ] as const) {
      expect((await h.listReceipts(id, jar)).status, who).toBe(status);
      expect((await h.getReceipt(id, receiptId, jar)).status, who).toBe(status);
    }
  });

  it('[FR-RCV-03] a receipt read through another order, or an unknown id, is 404', async () => {
    const { h, id, a, approvedOn } = await threeLines();
    const other = await h.approvedOrder([10]);
    const res = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId: a, quantity: 1 }]));
    const receiptId = (res.body as { id: string }).id;
    expect((await h.getReceipt(other.id, receiptId)).status).toBe(404);
    expect((await h.getReceipt(id, '00000000-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await h.listReceipts('00000000-0000-7000-8000-000000000000')).status).toBe(404);
  });
});
