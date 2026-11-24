import { RECEIPT_TIME_ZONE } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_PRIVILEGE,
  createDraft,
  orderFixture,
  plantCancelled,
  plantSubmitted,
  readOrder,
  sqlstate,
  type OrderFixture,
} from '../support/orders-sql.js';
import {
  ORDER_NOT_RECEIVABLE,
  RECEIPT_BEFORE_APPROVAL,
  RECEIPT_DATE_TOO_LATE,
  RECEIPT_EXCEEDS_ORDERED,
  RECEIPT_IMMUTABLE,
  RECEIPT_NOT_BY_OWNER,
  anotherBuyer,
  approvalDate,
  approvedDaysAgo,
  approvedOrder,
  asActor,
  buyer,
  databaseDate,
  insertReceipts,
  readLines,
  receiptCount,
  receive,
  type ReceiptRow,
  type SqlActor,
} from '../support/receipts-sql.js';

// Migration 0016, part 2 (specs/007-goods-receipt/research.md R2–R4, D12–D17): what the
// database itself refuses about receipts, whatever the role, and how one receipt
// statement keeps each line's received quantity and the order's open-line count. Raw SQL
// as po_app with the Buyer's actor context unless a test says otherwise. Reaching one of
// these SQLSTATEs through the API is a bug: the service checks the same rules first.

/** The SQLSTATE of one receipt statement on `orderId` as `actor` (default the Buyer). */
function attempt(
  f: OrderFixture,
  orderId: string,
  rows: readonly ReceiptRow[],
  actor: SqlActor = buyer(f),
) {
  return sqlstate(() => asActor(f.app, actor, (q) => insertReceipts(q, orderId, rows)));
}

/** A routed total (above the ₹1,00,000 tier), so pending and rejected can be planted. */
const ROUTED = [{ quantity: 2, unitPrice: '60000' }];

describe('[FR-RCV-01] a receipt statement keeps the derived values', () => {
  it('[FR-RCV-01] an allowed receipt sets received quantities and the open-line count, not the version or total', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [
      { quantity: 5, unitPrice: '2' },
      { quantity: 3, unitPrice: '1' },
      { quantity: 4, unitPrice: '1' },
    ]);
    const before = await readOrder(f.app, orderId);
    await receive(f, orderId, [
      { lineId: lineIds[0] ?? '', quantity: 2 },
      { lineId: lineIds[1] ?? '', quantity: 3 },
    ]);
    expect((await readLines(f.app, orderId)).map((l) => l.received_quantity)).toEqual([2, 3, 0]);
    expect(await readOrder(f.app, orderId)).toEqual({
      ...before,
      open_line_count: 2,
    });
    // A later delivery completes the first line: two rows on one line in one statement.
    await receive(f, orderId, [
      { lineId: lineIds[0] ?? '', quantity: 1 },
      { lineId: lineIds[0] ?? '', quantity: 2 },
    ]);
    expect((await readLines(f.app, orderId)).map((l) => l.received_quantity)).toEqual([5, 3, 0]);
    expect(await readOrder(f.app, orderId)).toMatchObject({
      open_line_count: 1,
      version: before?.version,
      total: before?.total,
      status: 'APPROVED',
    });
  });

  it('[FR-RCV-01] the last line completing leaves the order APPROVED with no open line', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 2, unitPrice: '1' }]);
    await receive(f, orderId, [{ lineId: lineIds[0] ?? '', quantity: 2 }]);
    expect(await readOrder(f.app, orderId)).toMatchObject({
      status: 'APPROVED',
      open_line_count: 0,
    });
  });

  it('[FR-RCV-01] recorded_at is the database clock, whatever is sent (as po_owner, who may send it)', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    await asActor(f.owner, buyer(f), (q) =>
      q.query(
        `INSERT INTO receipts (order_id, line_id, quantity, received_at, recorded_by, recorded_at)
         VALUES ($1, $2, 1, (now() AT TIME ZONE 'Asia/Kolkata')::date, $3, '2020-01-01T00:00:00Z')`,
        [orderId, lineIds[0], f.buyerId],
      ),
    );
    const { rows } = await f.app.query<{ fresh: boolean }>(
      `SELECT recorded_at > now() - interval '1 minute' AS fresh FROM receipts WHERE order_id = $1`,
      [orderId],
    );
    expect(rows).toEqual([{ fresh: true }]);
  });
});

describe('[FR-SM-01] D12: receipts only on approved orders', () => {
  it('[FR-SM-01] a receipt on a draft, pending, rejected or cancelled order is refused (PO020)', async () => {
    const f = await orderFixture();
    const draft = await createDraft(f, ROUTED);
    const pending = await createDraft(f, ROUTED);
    await plantSubmitted(f, pending.orderId, 'PENDING_APPROVAL');
    const rejected = await createDraft(f, ROUTED);
    await plantSubmitted(f, rejected.orderId, 'REJECTED');
    const cancelled = await createDraft(f, ROUTED);
    await plantCancelled(f, cancelled.orderId);
    for (const [name, order] of Object.entries({ draft, pending, rejected, cancelled })) {
      expect(
        await attempt(f, order.orderId, [{ lineId: order.lineIds[0] ?? '', quantity: 1 }]),
        name,
      ).toBe(ORDER_NOT_RECEIVABLE);
      expect(await receiptCount(f.app, order.orderId), name).toBe(0);
    }
  });
});

describe('[FR-RCV-02] D13: receipts by the owner, as the actor', () => {
  it('[FR-RCV-02] recorded_by not the owner, or not the actor, or a SYSTEM actor is refused (PO021)', async () => {
    const f = await orderFixture();
    const other = await anotherBuyer(f);
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const lineId = lineIds[0] ?? '';
    const otherActor: SqlActor = { type: 'USER', userId: other, role: 'BUYER' };
    // Another Buyer recording as themselves.
    expect(
      await attempt(f, orderId, [{ lineId, quantity: 1, recordedBy: other }], otherActor),
    ).toBe(RECEIPT_NOT_BY_OWNER);
    // Another Buyer recording in the owner's name.
    expect(await attempt(f, orderId, [{ lineId, quantity: 1 }], otherActor)).toBe(
      RECEIPT_NOT_BY_OWNER,
    );
    // The owner's actor naming someone else.
    expect(await attempt(f, orderId, [{ lineId, quantity: 1, recordedBy: other }])).toBe(
      RECEIPT_NOT_BY_OWNER,
    );
    expect(await attempt(f, orderId, [{ lineId, quantity: 1 }], { type: 'SYSTEM' })).toBe(
      RECEIPT_NOT_BY_OWNER,
    );
    expect(await attempt(f, orderId, [{ lineId, quantity: 1 }], { type: 'OPERATOR' })).toBe(
      RECEIPT_NOT_BY_OWNER,
    );
    expect(await receiptCount(f.app, orderId)).toBe(0);
  });
});

describe('[FR-RCV-02] D14 and D17: the receipt date', () => {
  it('[FR-RCV-02] a date before the approval day in India time is refused (PO024); the approval day is allowed', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    await approvedDaysAgo(f, orderId, 3);
    const lineId = lineIds[0] ?? '';
    const dayBefore = await approvalDate(f.app, orderId, -1);
    const approvalDay = await approvalDate(f.app, orderId);
    expect(await attempt(f, orderId, [{ lineId, quantity: 1, receivedAt: dayBefore }])).toBe(
      RECEIPT_BEFORE_APPROVAL,
    );
    expect(
      await attempt(f, orderId, [{ lineId, quantity: 1, receivedAt: approvalDay }]),
    ).toBeUndefined();
  });

  it("[FR-RCV-02] a date after the database's India date + 1 is refused (PO025); + 1 is allowed", async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const lineId = lineIds[0] ?? '';
    expect(
      await attempt(f, orderId, [
        { lineId, quantity: 1, receivedAt: await databaseDate(f.app, 2) },
      ]),
    ).toBe(RECEIPT_DATE_TOO_LATE);
    expect(
      await attempt(f, orderId, [
        { lineId, quantity: 1, receivedAt: await databaseDate(f.app, 1) },
      ]),
    ).toBeUndefined();
  });

  it('[FR-RCV-02] the time zone in D14 and D17 is RECEIPT_TIME_ZONE', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ def: string }>(
      `SELECT pg_get_functiondef('receipts_after_insert'::regproc) AS def`,
    );
    const zones = [...(rows[0]?.def ?? '').matchAll(/AT TIME ZONE '([^']+)'/g)].map(([, z]) => z);
    expect(zones).toHaveLength(2);
    expect(new Set(zones)).toEqual(new Set([RECEIPT_TIME_ZONE]));
  });
});

describe('[FR-RCV-02] D15: received never exceeds ordered', () => {
  it('[FR-RCV-02] one line over its ordered quantity is refused (PO022), naming the line by position', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [
      { quantity: 5, unitPrice: '1' },
      { quantity: 3, unitPrice: '1' },
    ]);
    const error = await asActor(f.app, buyer(f), (q) =>
      insertReceipts(q, orderId, [{ lineId: lineIds[1] ?? '', quantity: 4 }]),
    ).catch((e: unknown) => e as { code?: string; message?: string; detail?: string });
    expect(error).toMatchObject({ code: RECEIPT_EXCEEDS_ORDERED });
    expect((error as { detail?: string }).detail).toContain('line 2');
  });

  it('[FR-RCV-02] two rows on one line summing over, or over what was already received, are refused', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const lineId = lineIds[0] ?? '';
    expect(
      await attempt(f, orderId, [
        { lineId, quantity: 3 },
        { lineId, quantity: 3 },
      ]),
    ).toBe(RECEIPT_EXCEEDS_ORDERED);
    await receive(f, orderId, [{ lineId, quantity: 3 }]);
    expect(await attempt(f, orderId, [{ lineId, quantity: 3 }])).toBe(RECEIPT_EXCEEDS_ORDERED);
    expect(await attempt(f, orderId, [{ lineId, quantity: 2 }])).toBeUndefined();
    expect((await readLines(f.app, orderId))[0]?.received_quantity).toBe(5);
  });

  it('[FR-RCV-02] a multi-line statement with one bad line writes nothing', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [
      { quantity: 5, unitPrice: '1' },
      { quantity: 3, unitPrice: '1' },
      { quantity: 4, unitPrice: '1' },
    ]);
    expect(
      await attempt(f, orderId, [
        { lineId: lineIds[0] ?? '', quantity: 1 },
        { lineId: lineIds[1] ?? '', quantity: 9 },
        { lineId: lineIds[2] ?? '', quantity: 4 },
      ]),
    ).toBe(RECEIPT_EXCEEDS_ORDERED);
    expect(await receiptCount(f.app, orderId)).toBe(0);
    expect((await readLines(f.app, orderId)).map((l) => l.received_quantity)).toEqual([0, 0, 0]);
    expect(await readOrder(f.app, orderId)).toMatchObject({ open_line_count: 3 });
  });
});

describe('[FR-RCV-02] D16: receipts never change', () => {
  it('[FR-RCV-02] update, delete and truncate are refused: po_app has no privilege, po_owner gets PO023', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    await receive(f, orderId, [{ lineId: lineIds[0] ?? '', quantity: 2 }]);
    const statements = [
      `UPDATE receipts SET quantity = 1 WHERE order_id = '${orderId}'`,
      `DELETE FROM receipts WHERE order_id = '${orderId}'`,
      `TRUNCATE receipts`,
    ];
    for (const sql of statements) {
      expect(
        await sqlstate(() => asActor(f.app, buyer(f), (q) => q.query(sql))),
        `po_app: ${sql}`,
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await sqlstate(() => asActor(f.owner, buyer(f), (q) => q.query(sql))),
        `po_owner: ${sql}`,
      ).toBe(RECEIPT_IMMUTABLE);
    }
    expect(await receiptCount(f.app, orderId)).toBe(1);
  });
});
