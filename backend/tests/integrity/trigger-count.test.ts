import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDraft,
  inTransaction,
  insertLines,
  orderFixture,
  type OrderFixture,
} from '../support/orders-sql.js';

// The recompute runs once per line statement, never once per line (FR-021, ADR-0003): an
// edit's at most three line statements (insert, update, delete) recompute at most three
// times whatever the line count. recompute_orders counts its runs in the transaction-local
// setting po.recompute_count, read here in the same transaction.

async function countIn(f: OrderFixture, work: (q: OrderFixture['app']) => Promise<unknown>) {
  return inTransaction(f.app, async (q) => {
    await work(q);
    const { rows } = await q.query<{ n: string | null }>(
      `SELECT current_setting('po.recompute_count', true) AS n`,
    );
    return Number(rows[0]?.n || 0);
  });
}

const lines = (n: number) => Array.from({ length: n }, () => ({ quantity: 2, unitPrice: '1.25' }));

describe('[NFR-PERF-03] derived values recompute once per statement', () => {
  it('[NFR-PERF-03] a 500-line create recomputes once', async () => {
    const f = await orderFixture();
    const count = await countIn(f, async (q) => {
      const id = randomUUID();
      await q.query(`INSERT INTO purchase_orders (id, owner_id, vendor_id) VALUES ($1, $2, $3)`, [
        id,
        f.buyerId,
        f.vendorId,
      ]);
      await insertLines(q, id, lines(500));
      await q.query(`UPDATE purchase_orders SET po_number = 'PO-2026-27-000001' WHERE id = $1`, [
        id,
      ]);
    });
    expect(count).toBe(1);
  });

  it('[NFR-PERF-03] a 500-line edit that changes every quantity recomputes once', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, lines(500));
    expect(
      await countIn(f, (q) =>
        q.query(`UPDATE order_lines SET quantity = quantity + 1 WHERE order_id = $1`, [orderId]),
      ),
    ).toBe(1);
  });

  it('[NFR-PERF-03] an edit that adds, changes and removes lines recomputes three times', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await createDraft(f, lines(300));
    expect(
      await countIn(f, async (q) => {
        await insertLines(q, orderId, lines(100), 300);
        await q.query(`UPDATE order_lines SET unit_price = 2 WHERE id = ANY($1)`, [
          lineIds.slice(0, 200),
        ]);
        await q.query(`DELETE FROM order_lines WHERE id = ANY($1)`, [lineIds.slice(200)]);
      }),
    ).toBe(3);
  });

  it('[NFR-PERF-03] vendor-, version-, timestamp- and description-only updates recompute nothing', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await createDraft(f, lines(20));
    expect(
      await countIn(f, async (q) => {
        await q.query(`UPDATE purchase_orders SET vendor_id = vendor_id WHERE id = $1`, [orderId]);
        await q.query(`UPDATE purchase_orders SET version = version + 1 WHERE id = $1`, [orderId]);
        await q.query(`UPDATE order_lines SET description = 'Renamed' WHERE id = ANY($1)`, [
          lineIds,
        ]);
      }),
    ).toBe(0);
    expect(
      await inTransaction(f.owner, async (q) => {
        await q.query(`UPDATE purchase_orders SET updated_at = now() WHERE id = $1`, [orderId]);
        const { rows } = await q.query<{ n: string | null }>(
          `SELECT current_setting('po.recompute_count', true) AS n`,
        );
        return Number(rows[0]?.n || 0);
      }),
    ).toBe(0);
  });

  it('[NFR-PERF-03] one statement touching lines of several orders recomputes once', async () => {
    const f = await orderFixture();
    const a = await createDraft(f, lines(10));
    const b = await createDraft(f, lines(10));
    expect(
      await countIn(f, (q) =>
        q.query(`UPDATE order_lines SET quantity = 5 WHERE order_id = ANY($1)`, [
          [a.orderId, b.orderId],
        ]),
      ),
    ).toBe(1);
  });
});
