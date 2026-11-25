import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  indiaDate,
  indiaHalfPastMidnight,
  receiptBody,
  receiptsHarness,
  type ReceiptsHarness,
} from '../support/receipts.js';

// Recording receipts through the API (US1, FR-001, FR-006, FR-007, FR-013; research R5–R7):
// the owner of an approved order records a partial, then a full delivery; each command is
// one receipt with its lines, one GOODS_RECEIPT_RECORDED per line, and the order's version
// never moves. The receipt date is an India calendar date from the injected clock.

/** An approved one-line order of 100, with the clock at 00:30 India time on its approval day. */
async function approvedHundred() {
  const h = await receiptsHarness();
  const order = await h.approvedOrder([100]);
  await h.setClock(indiaHalfPastMidnight(order.approvedOn));
  return { h, ...order, lineId: order.lineIds[0] ?? '' };
}

async function orderVersion(h: ReceiptsHarness, id: string) {
  const res = await h.getOrder(id);
  return { version: (res.body as { version: number }).version, etag: res.headers['etag'] };
}

describe('[FR-RCV-01] record a partial, then a full receipt', () => {
  it('[FR-RCV-01] 40 then 60 of 100: partly, then fully received; still APPROVED; the version never moves', async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    const before = await orderVersion(h, id);

    const first = await h.recordReceipt(
      id,
      receiptBody(approvedOn, [{ lineId, quantity: 40 }], { note: 'First delivery' }),
    );
    expect(first.status).toBe(201);
    const firstId = (first.body as { id: string }).id;
    expect(first.headers['location']).toBe(`/api/orders/${id}/receipts/${firstId}`);
    const { recordedAt, ...firstReceipt } = first.body as { recordedAt: string };
    expect(recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(firstReceipt).toEqual({
      id: firstId,
      receivedOn: approvedOn,
      note: 'First delivery',
      receiptProgress: 'PARTIALLY_RECEIVED',
      lines: [
        {
          lineId,
          position: 0,
          quantity: 40,
          receivedBefore: 0,
          receivedAfter: 40,
          outstandingAfter: 60,
        },
      ],
    });

    const second = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId, quantity: 60 }]));
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({
      note: null,
      receiptProgress: 'FULLY_RECEIVED',
      lines: [{ receivedBefore: 40, receivedAfter: 100, outstandingAfter: 0 }],
    });

    const order = await h.getOrder(id);
    expect(order.body).toMatchObject({ status: 'APPROVED', version: before.version });
    expect(order.headers['etag']).toBe(before.etag);
    expect(await h.receiptCounts(id)).toEqual({ receipts: 2, lines: 2 });
  });

  it('[NFR-AUD-01] each receipt line writes one GOODS_RECEIPT_RECORDED with the receipt id and both dates', async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    const res = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId, quantity: 40 }]));
    const receipt = res.body as { id: string; recordedAt: string };
    expect(await h.receiptAudit()).toEqual([
      expect.objectContaining({
        entity_type: 'order',
        entity_id: id,
        order_id: id,
        actor_type: 'USER',
        actor_user_id: h.buyer.id,
        acting_role: 'BUYER',
        details: {
          receiptId: receipt.id,
          lineId,
          position: 0,
          quantity: 40,
          receivedBefore: 0,
          receivedAfter: 40,
          outstandingAfter: 60,
          receivedOn: approvedOn,
          recordedAt: receipt.recordedAt,
          note: null,
        },
      }),
    ]);
  });
});

describe('[FR-RCV-02] the receipt date, an India calendar date', () => {
  it('[FR-RCV-02] at 00:30 India time, today (the approval day) is accepted', async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    expect(indiaDate(h.clock.now())).toBe(approvedOn);
    const res = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId, quantity: 1 }]));
    expect(res.status).toBe(201);
  });

  it('[FR-RCV-02] tomorrow in India is 400 DATE_IN_FUTURE; nothing recorded', async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    const tomorrow = indiaDate(h.clock.now(), 1);
    const res = await h.recordReceipt(id, receiptBody(tomorrow, [{ lineId, quantity: 1 }]));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.receivedOn', code: 'DATE_IN_FUTURE' }],
    });
    expect(await h.receiptCounts(id)).toEqual({ receipts: 0, lines: 0 });
    expect(approvedOn).not.toBe(tomorrow);
  });

  it("[FR-RCV-02] the day before the order's approval is 400 DATE_BEFORE_APPROVAL", async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    const [row] = await h.query<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [approvedOn]);
    const res = await h.recordReceipt(id, receiptBody(row?.d ?? '', [{ lineId, quantity: 1 }]));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.receivedOn', code: 'DATE_BEFORE_APPROVAL' }],
    });
    expect(await h.receiptCounts(id)).toEqual({ receipts: 0, lines: 0 });
  });

  it('[FR-VEN-02] a receipt is recorded even if the vendor was deactivated after approval', async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(`UPDATE vendors SET status = 'INACTIVE', deactivated_at = now() WHERE id = $1`, [
      h.vendorId,
    ]);
    await h.query('COMMIT');
    const res = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId, quantity: 5 }]));
    expect(res.status).toBe(201);
  });
});

describe('[NFR-CON-03] a receipt is idempotent and needs no If-Match', () => {
  it('[NFR-CON-03] the Idempotency-Key is required and a UUID', async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    const body = receiptBody(approvedOn, [{ lineId, quantity: 1 }]);
    const none = await h.recordReceipt(id, body, { key: null });
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({
      details: [{ path: 'header.idempotency-key', code: 'REQUIRED' }],
    });
    const bad = await h.recordReceipt(id, body, { key: 'not-a-uuid' });
    expect(bad.body).toMatchObject({
      details: [{ path: 'header.idempotency-key', code: 'INVALID_FORMAT' }],
    });
    expect(await h.receiptCounts(id)).toEqual({ receipts: 0, lines: 0 });
  });

  it('[NFR-CON-03] the same key and body replays the stored response; one receipt', async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    const key = randomUUID();
    const body = receiptBody(approvedOn, [{ lineId, quantity: 40 }]);
    const first = await h.recordReceipt(id, body, { key });
    const again = await h.recordReceipt(id, body, { key });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await h.receiptCounts(id)).toEqual({ receipts: 1, lines: 1 });
    expect(await h.receiptAudit()).toHaveLength(1);
  });

  it('[NFR-CON-03] the same key with another body, or on another order, is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    const other = await h.approvedOrder([10]);
    const key = randomUUID();
    await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId, quantity: 1 }]), { key });
    const changed = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId, quantity: 2 }]), {
      key,
    });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const elsewhere = await h.recordReceipt(
      other.id,
      receiptBody(approvedOn, [{ lineId: other.lineIds[0] ?? '', quantity: 1 }]),
      { key },
    );
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await h.receiptCounts(other.id)).toEqual({ receipts: 0, lines: 0 });
  });
});

describe('[NFR-AUTH-01] who may record a receipt', () => {
  it("[NFR-AUTH-01] a pure Approver gets 403 FORBIDDEN with the receipt's own message", async () => {
    const { h, id, lineId, approvedOn } = await approvedHundred();
    const priya = await h.approver();
    const res = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId, quantity: 1 }]), {
      as: priya.jar,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'FORBIDDEN',
      detail: "Approvers can't record receipts. The order's Buyer records them.",
    });
  });
});
