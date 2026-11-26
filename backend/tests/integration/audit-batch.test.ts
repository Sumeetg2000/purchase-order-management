import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/events.js';
import { writeAuditBatch } from '../../src/audit/write.js';
import { createPrismaClient } from '../../src/db/client.js';
import { withTransaction, type AuditedTransaction } from '../../src/db/transaction.js';
import { testLogger } from '../support/log-capture.js';
import { orderFixture, type OrderFixture } from '../support/orders-sql.js';
import { approvedOrder } from '../support/receipts-sql.js';

// writeAuditBatch (specs/007-goods-receipt/research.md R6, ADR-0016): a receipt's
// GOODS_RECEIPT_RECORDED entries, one per receipt line, are written by one INSERT … SELECT
// FROM unnest, whatever their number, and the database fills every row's actor (name,
// email, capacity) and request id from the transaction's context, as for writeAudit.

const BUYER = { name: 'Asha Rao', email: 'asha@example.local' };

/** Counts the raw statements `work` sends through the transaction. */
function counting(tx: AuditedTransaction) {
  let statements = 0;
  const counted = new Proxy(tx, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (
        typeof key === 'string' &&
        /^\$(execute|query)Raw/.test(key) &&
        typeof value === 'function'
      ) {
        return (...args: unknown[]) => {
          statements += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { tx: counted, statements: () => statements };
}

/**
 * Records one receipt over `lineIds` (one unit each) as the fixture's Buyer, then writes
 * its entries with writeAuditBatch; returns the receipt id and the batch's statement count.
 */
async function receiptWithAudit(f: OrderFixture, orderId: string, lineIds: string[]) {
  const prisma = createPrismaClient({
    url: f.db.url('po_app'),
    poolSize: 2,
    connectionTimeoutMs: 2_000,
  });
  try {
    return await withTransaction(
      {
        prisma,
        actor: { type: 'USER', userId: f.buyerId, actingRole: 'BUYER', ...BUYER },
        requestId: 'req-receipt-0001',
        timeoutMs: 20_000,
        maxWaitMs: 2_000,
        logger: testLogger(),
      },
      async (tx) => {
        const rows = await tx.$queryRaw<
          { receipt_id: string; line_id: string; position: number; po_number: string; at: string }[]
        >`
          WITH r AS (
            INSERT INTO goods_receipts (order_id, received_on, recorded_by)
            VALUES (${orderId}::uuid, (now() AT TIME ZONE 'Asia/Kolkata')::date, ${f.buyerId}::uuid)
            RETURNING id, order_id, recorded_at
          ), l AS (
            INSERT INTO goods_receipt_lines (receipt_id, order_id, line_id, quantity)
            SELECT r.id, r.order_id, x, 1 FROM r, unnest(${lineIds}::uuid[]) AS x
            RETURNING receipt_id, line_id
          )
          SELECT l.receipt_id::text, l.line_id::text, ol.position, o.po_number,
                 (SELECT recorded_at FROM r)::text AS at
            FROM l JOIN order_lines ol ON ol.id = l.line_id
            JOIN purchase_orders o ON o.id = ol.order_id
           ORDER BY ol.position`;
        const events: AuditEvent[] = rows.map((row) => ({
          action: 'GOODS_RECEIPT_RECORDED',
          entityType: 'order',
          entityId: orderId,
          orderId,
          poNumber: row.po_number,
          details: {
            receiptId: row.receipt_id,
            lineId: row.line_id,
            position: row.position,
            quantity: 1,
            receivedBefore: 0,
            receivedAfter: 1,
            outstandingAfter: 4,
            receivedOn: '2026-11-25',
            recordedAt: row.at,
            note: null,
          },
        }));
        const { tx: counted, statements } = counting(tx);
        await writeAuditBatch(counted, events);
        return { receiptId: rows[0]?.receipt_id, statements: statements() };
      },
    );
  } finally {
    await prisma.$disconnect();
  }
}

describe('[NFR-AUD-01] writeAuditBatch', () => {
  it('[NFR-AUD-01] a multi-line receipt: one entry per line, each with the actor, capacity, request id and receipt id', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(
      f,
      [1, 2, 3].map(() => ({ quantity: 5, unitPrice: '1' })),
    );
    const { receiptId, statements } = await receiptWithAudit(f, orderId, lineIds);
    expect(statements).toBe(1);
    const { rows } = await f.superuser.query<Record<string, unknown>>(
      `SELECT action, entity_type, entity_id::text, order_id::text, actor_type,
              actor_user_id::text, actor_name, actor_email, acting_role, request_id,
              details->>'receiptId' AS receipt_id, details->>'lineId' AS line_id
         FROM audit_entries WHERE action = 'GOODS_RECEIPT_RECORDED'
        ORDER BY (details->>'position')::int`,
    );
    expect(rows).toEqual(
      lineIds.map((lineId) => ({
        action: 'GOODS_RECEIPT_RECORDED',
        entity_type: 'order',
        entity_id: orderId,
        order_id: orderId,
        actor_type: 'USER',
        actor_user_id: f.buyerId,
        actor_name: BUYER.name,
        actor_email: BUYER.email,
        acting_role: 'BUYER',
        request_id: 'req-receipt-0001',
        receipt_id: receiptId,
        line_id: lineId,
      })),
    );
  });

  it('[NFR-PERF-03] 500 entries are still one statement', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(
      f,
      Array.from({ length: 500 }, () => ({ quantity: 5, unitPrice: '1' })),
    );
    const { statements } = await receiptWithAudit(f, orderId, lineIds);
    expect(statements).toBe(1);
    const { rows } = await f.superuser.query<{ n: number; requests: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT request_id)::int AS requests
         FROM audit_entries WHERE action = 'GOODS_RECEIPT_RECORDED'`,
    );
    expect(rows[0]).toEqual({ n: 500, requests: 1 });
  });

  it('[NFR-AUD-01] an empty batch writes nothing and sends no statement', async () => {
    const f = await orderFixture();
    const prisma = createPrismaClient({
      url: f.db.url('po_app'),
      poolSize: 1,
      connectionTimeoutMs: 2_000,
    });
    try {
      const sent = await withTransaction(
        {
          prisma,
          actor: { type: 'USER', userId: f.buyerId, actingRole: 'BUYER', ...BUYER },
          requestId: 'req-receipt-0002',
          timeoutMs: 5_000,
          maxWaitMs: 2_000,
          logger: testLogger(),
        },
        async (tx) => {
          const { tx: counted, statements } = counting(tx);
          await writeAuditBatch(counted, []);
          return statements();
        },
      );
      expect(sent).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
