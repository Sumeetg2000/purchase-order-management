import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { plantsViolations } from '../support/setup.js';
import {
  createDraft,
  orderFixture,
  plant,
  reconciliationRows,
  type OrderFixture,
} from '../support/orders-sql.js';

// The committed reconciliation query (data-model.md): one row per broken invariant, none
// when every stored derived value agrees with what it is derived from. Each violation is
// planted below the guards (as the superuser, triggers off; DDL inside a rolled-back
// transaction where a CHECK or a generated column makes the state unreachable otherwise).

/** Runs `plantSql` and then the reconciliation in one superuser transaction, rolled back. */
async function rowsAfter(f: OrderFixture, plantSql: string[]): Promise<string[][]> {
  const q: pg.Client = f.superuser;
  await q.query('BEGIN');
  try {
    await q.query(`SET LOCAL session_replication_role = replica`);
    for (const sql of plantSql) await q.query(sql);
    const rows = await reconciliationRows(q);
    return rows.map((r) => [r.invariant, r.entity_id]);
  } finally {
    await q.query('ROLLBACK');
  }
}

/**
 * A committed draft whose stored total and open-line count are right, set directly so
 * this suite doesn't depend on the triggers that normally keep them.
 */
async function consistentDraft(f: OrderFixture, lines: Parameters<typeof createDraft>[1]) {
  const draft = await createDraft(f, lines);
  await plant(
    f,
    `UPDATE purchase_orders o
        SET total = s.total, open_line_count = s.open
       FROM (SELECT sum(line_total) AS total,
                    count(*) FILTER (WHERE received_quantity < quantity) AS open
               FROM order_lines WHERE order_id = $1) s
      WHERE o.id = $1`,
    [draft.orderId],
  );
  return draft;
}

describe('[NFR-DATA-01] reconciliation query', () => {
  it('[NFR-DATA-01] returns no rows for consistent drafts, run as po_app', async () => {
    const f = await orderFixture();
    await consistentDraft(f, [
      { quantity: 3, unitPrice: '0.1' },
      { quantity: 7, unitPrice: '0.0125' },
    ]);
    expect(await reconciliationRows(f.app)).toEqual([]);
  });

  it('[NFR-DATA-01] INV-1: a line total that is not quantity × unit price', async () => {
    const f = await orderFixture();
    const { lineIds } = await consistentDraft(f, [{ quantity: 2, unitPrice: '5' }]);
    const lineId = lineIds[0] ?? '';
    expect(
      await rowsAfter(f, [
        `ALTER TABLE order_lines ALTER COLUMN line_total DROP EXPRESSION`,
        `UPDATE order_lines SET line_total = 11 WHERE id = '${lineId}'`,
      ]),
    ).toContainEqual(['INV-1', lineId]);
  });

  it('[NFR-DATA-01] INV-2: an order total that is not the sum of its lines', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const { orderId } = await consistentDraft(f, [{ quantity: 2, unitPrice: '5' }]);
    await plant(f, `UPDATE purchase_orders SET total = 9 WHERE id = $1`, [orderId]);
    expect(await reconciliationRows(f.app)).toEqual([
      { invariant: 'INV-2', entity_id: orderId, detail: 'total 9.0000, lines sum to 10.0000' },
    ]);
  });

  it('[NFR-DATA-01] INV-4: a received quantity outside 0..quantity', async () => {
    const f = await orderFixture();
    const { lineIds } = await consistentDraft(f, [{ quantity: 2, unitPrice: '5' }]);
    const lineId = lineIds[0] ?? '';
    const rows = await rowsAfter(f, [
      `ALTER TABLE order_lines DROP CONSTRAINT order_lines_received_quantity_range`,
      `UPDATE order_lines SET received_quantity = 3 WHERE id = '${lineId}'`,
    ]);
    expect(rows).toContainEqual(['INV-4', lineId]);
  });

  it('[NFR-DATA-01] INV-5: an order with no line', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const { orderId } = await consistentDraft(f, [{ quantity: 2, unitPrice: '5' }]);
    await plant(f, `DELETE FROM order_lines WHERE order_id = $1`, [orderId]);
    const rows = (await reconciliationRows(f.app)).map((r) => [r.invariant, r.entity_id]);
    // The stored total and open-line count are now stale too.
    expect(rows).toEqual([
      ['INV-2', orderId],
      ['INV-5', orderId],
      ['INV-6', orderId],
    ]);
  });

  it('[NFR-DATA-01] INV-6: an open-line count that is not the count of open lines', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const { orderId } = await consistentDraft(f, [
      { quantity: 2, unitPrice: '5' },
      { quantity: 1, unitPrice: '5' },
    ]);
    await plant(f, `UPDATE purchase_orders SET open_line_count = 1 WHERE id = $1`, [orderId]);
    expect(await reconciliationRows(f.app)).toEqual([
      { invariant: 'INV-6', entity_id: orderId, detail: 'open_line_count 1, open lines 2' },
    ]);
  });

  it('[NFR-DATA-01] an order committed without a PO number', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const orderId = randomUUID();
    await plant(
      f,
      `WITH o AS (INSERT INTO purchase_orders (id, owner_id, vendor_id, total, open_line_count)
                  VALUES ($1, $2, $3, 5, 1) RETURNING id)
       INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price)
       SELECT gen_random_uuid(), id, 0, 'Bolts', 1, 5 FROM o`,
      [orderId, f.buyerId, f.vendorId],
    );
    expect(await reconciliationRows(f.app)).toEqual([
      { invariant: 'PO_NUMBER', entity_id: orderId, detail: 'po_number is NULL' },
    ]);
  });
});
