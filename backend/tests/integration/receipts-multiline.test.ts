import { describe, expect, it } from 'vitest';
import { indiaHalfPastMidnight, receiptBody, receiptsHarness } from '../support/receipts.js';

// Several lines at once, all or nothing (US2, FR-002, FR-RCV-01, FR-RCV-02; research R5
// step 9): one command covering several lines records every line or none. Any line over
// its outstanding refuses the whole command with every offending line listed, in position
// order; nothing is written, not even an audit entry.

/** An approved order with lines A 10, B 5, C 8, the clock at 00:30 India on its approval day. */
async function threeLines() {
  const h = await receiptsHarness();
  const order = await h.approvedOrder([10, 5, 8]);
  const jar = await h.setClock(indiaHalfPastMidnight(order.approvedOn));
  const [a = '', b = '', c = ''] = order.lineIds;
  return { h, jar, ...order, a, b, c };
}

async function received(h: Awaited<ReturnType<typeof threeLines>>['h'], id: string) {
  const res = await h.getOrder(id);
  return (res.body as { lines: { receivedQuantity: number }[] }).lines.map(
    (l) => l.receivedQuantity,
  );
}

describe('[FR-RCV-01] several lines in one receipt, all or nothing', () => {
  it('[FR-RCV-02] one line over: 409 naming it with its outstanding and the request; nothing recorded', async () => {
    const { h, id, a, b, c, approvedOn } = await threeLines();
    const res = await h.recordReceipt(
      id,
      receiptBody(approvedOn, [
        { lineId: a, quantity: 10 },
        { lineId: b, quantity: 6 },
        { lineId: c, quantity: 8 },
      ]),
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'RECEIPT_EXCEEDS_OUTSTANDING',
      lines: [{ lineId: b, position: 1, outstanding: 5, requested: 6 }],
      detail: 'Nothing was recorded. Line 2 has only 5 outstanding; you entered 6.',
    });
    expect(await h.receiptCounts(id)).toEqual({ receipts: 0, lines: 0 });
    expect(await h.receiptAudit()).toEqual([]);
    expect(await received(h, id)).toEqual([0, 0, 0]);
  });

  it('[FR-RCV-02] every offending line is listed, in position order, whatever the body order', async () => {
    const { h, id, a, b, approvedOn } = await threeLines();
    const res = await h.recordReceipt(
      id,
      receiptBody(approvedOn, [
        { lineId: b, quantity: 6 },
        { lineId: a, quantity: 11 },
      ]),
    );
    expect(res.status).toBe(409);
    expect((res.body as { lines: unknown[] }).lines).toEqual([
      { lineId: a, position: 0, outstanding: 10, requested: 11 },
      { lineId: b, position: 1, outstanding: 5, requested: 6 },
    ]);
  });

  it('[FR-RCV-01] three lines that fit: one receipt with 3 lines, 3 entries sharing its id, date and note', async () => {
    const { h, id, a, b, c, approvedOn } = await threeLines();
    const res = await h.recordReceipt(
      id,
      receiptBody(
        approvedOn,
        [
          { lineId: a, quantity: 10 },
          { lineId: b, quantity: 5 },
          { lineId: c, quantity: 3 },
        ],
        { note: 'One van' },
      ),
    );
    expect(res.status).toBe(201);
    const receipt = res.body as { id: string; receiptProgress: string };
    expect(receipt.receiptProgress).toBe('PARTIALLY_RECEIVED');
    expect(await h.receiptCounts(id)).toEqual({ receipts: 1, lines: 3 });
    const entries = (await h.receiptAudit()).map((e) => e.details as Record<string, unknown>);
    expect(entries.map((d) => [d['receiptId'], d['receivedOn'], d['note'], d['position']])).toEqual(
      [
        [receipt.id, approvedOn, 'One van', 0],
        [receipt.id, approvedOn, 'One van', 1],
        [receipt.id, approvedOn, 'One van', 2],
      ],
    );
    expect(await received(h, id)).toEqual([10, 5, 3]);
  });

  it('[FR-RCV-02] a fully received line with any quantity is 409 naming it', async () => {
    const { h, id, b, approvedOn } = await threeLines();
    await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId: b, quantity: 5 }]));
    const res = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId: b, quantity: 1 }]));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'RECEIPT_EXCEEDS_OUTSTANDING',
      lines: [{ lineId: b, position: 1, outstanding: 0, requested: 1 }],
    });
  });

  it('[FR-RCV-02] a line of another order, even one the caller owns, is LINE_NOT_FOUND', async () => {
    const { h, id, a, approvedOn } = await threeLines();
    const other = await h.approvedOrder([4]);
    const res = await h.recordReceipt(
      id,
      receiptBody(approvedOn, [
        { lineId: a, quantity: 1 },
        { lineId: other.lineIds[0] ?? '', quantity: 1 },
      ]),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.lines.1.lineId', code: 'LINE_NOT_FOUND' }],
    });
    expect(await h.receiptCounts(id)).toEqual({ receipts: 0, lines: 0 });
  });

  it('[FR-RCV-01] a 500-line receipt is accepted', async () => {
    const h = await receiptsHarness();
    const order = await h.approvedOrder(Array.from({ length: 500 }, () => 2));
    await h.setClock(indiaHalfPastMidnight(order.approvedOn));
    const res = await h.recordReceipt(
      order.id,
      receiptBody(
        order.approvedOn,
        order.lineIds.map((lineId) => ({ lineId, quantity: 1 })),
      ),
    );
    expect(res.status).toBe(201);
    expect(await h.receiptCounts(order.id)).toEqual({ receipts: 1, lines: 500 });
    expect(await h.receiptAudit()).toHaveLength(500);
  });
});

describe('[NFR-VAL-01] a receipt body that is not valid', () => {
  it('[NFR-VAL-01] quantities, duplicates, line count, note, unknown and read-only fields', async () => {
    const { h, id, a, b, approvedOn } = await threeLines();
    const one = (quantity: unknown) => [{ lineId: a, quantity }];
    const cases: [unknown, { path: string; code: string }][] = [
      [
        receiptBody(approvedOn, one(0) as never),
        { path: 'body.lines.0.quantity', code: 'OUT_OF_RANGE' },
      ],
      [
        receiptBody(approvedOn, one(-1) as never),
        { path: 'body.lines.0.quantity', code: 'OUT_OF_RANGE' },
      ],
      [
        receiptBody(approvedOn, one(1.5) as never),
        { path: 'body.lines.0.quantity', code: 'INVALID_FORMAT' },
      ],
      [
        receiptBody(approvedOn, one(1_000_001) as never),
        { path: 'body.lines.0.quantity', code: 'OUT_OF_RANGE' },
      ],
      [
        receiptBody(approvedOn, [
          { lineId: a, quantity: 1 },
          { lineId: b, quantity: 1 },
          { lineId: a, quantity: 1 },
        ]),
        { path: 'body.lines.2.lineId', code: 'DUPLICATE_LINE_ID' },
      ],
      [receiptBody(approvedOn, []), { path: 'body.lines', code: 'TOO_SHORT' }],
      [
        receiptBody(
          approvedOn,
          Array.from({ length: 501 }, (_, i) => ({
            lineId: `0192f0c4-1c2d-7e3f-8a4b-${i.toString(16).padStart(12, '0')}`,
            quantity: 1,
          })),
        ),
        { path: 'body.lines', code: 'TOO_LONG' },
      ],
      [
        receiptBody(approvedOn, one(1) as never, { note: 'x'.repeat(501) }),
        { path: 'body.note', code: 'TOO_LONG' },
      ],
      [
        receiptBody(approvedOn, one(1) as never, { vendorId: a }),
        { path: 'body.vendorId', code: 'UNKNOWN_FIELD' },
      ],
      [
        receiptBody(approvedOn, one(1) as never, { receiptProgress: 'FULLY_RECEIVED' }),
        { path: 'body.receiptProgress', code: 'READ_ONLY_FIELD' },
      ],
    ];
    for (const [body, detail] of cases) {
      const res = await h.recordReceipt(id, body);
      expect(res.status, detail.code).toBe(400);
      expect(res.body, detail.code).toMatchObject({ code: 'VALIDATION_FAILED', details: [detail] });
    }
    expect(await h.receiptCounts(id)).toEqual({ receipts: 0, lines: 0 });
  });
});
