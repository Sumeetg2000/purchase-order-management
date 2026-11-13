import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DERIVED_VALUE_READ_ONLY,
  GENERATED_ALWAYS,
  INSUFFICIENT_PRIVILEGE,
  ORDER_FIELD_IMMUTABLE,
  ORDER_STATUS_TRANSITION_REFUSED,
  ORDER_WITHOUT_LINES,
  createDraft,
  inTransaction,
  insertLines,
  orderFixture,
  readOrder,
  reconciliationRows,
  sqlstate,
  type OrderFixture,
} from '../support/orders-sql.js';

// The integrity attack suite (ADR-0003, FR-014): every known path to an order total that
// disagrees with its lines, tried below the API, as the application's database role and as
// the privileged owner role. Each attack must be refused with its specific outcome, or
// leave the derived values right; after each one the reconciliation query returns no rows.
// The API and service attacks join this file with the paths they attack (US1, US3).

let fixture: OrderFixture | undefined;
afterEach(async () => {
  if (fixture) expect(await reconciliationRows(fixture.app)).toEqual([]);
  fixture = undefined;
});

async function setup() {
  fixture = await orderFixture();
  const draft = await createDraft(fixture, [
    { quantity: 3, unitPrice: '0.1' },
    { quantity: 7, unitPrice: '0.0125' },
  ]);
  return { f: fixture, ...draft };
}

const asApp = (f: OrderFixture, sql: string, params: unknown[] = []) =>
  sqlstate(() => inTransaction(f.app, (q) => q.query(sql, params)));
const asOwner = (f: OrderFixture, sql: string, params: unknown[] = []) =>
  sqlstate(() => inTransaction(f.owner, (q) => q.query(sql, params)));

describe('[FR-PO-04] attacks as the application role (po_app)', () => {
  it('[FR-PO-04] a direct write of a derived or system-assigned column is permission denied', async () => {
    const { f, orderId } = await setup();
    for (const set of [
      'total = 1',
      'open_line_count = 0',
      "status = 'APPROVED'",
      'id = gen_random_uuid()',
      'owner_id = gen_random_uuid()',
      'created_at = now()',
    ]) {
      expect(
        await asApp(f, `UPDATE purchase_orders SET ${set} WHERE id = $1`, [orderId]),
        set,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
    for (const set of ['received_quantity = 1', 'order_id = gen_random_uuid()']) {
      expect(
        await asApp(f, `UPDATE order_lines SET ${set} WHERE order_id = $1`, [orderId]),
        set,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // A generated column refuses any written value before privileges are checked.
    expect(
      await asApp(f, `UPDATE order_lines SET line_total = 1 WHERE order_id = $1`, [orderId]),
    ).toBe(GENERATED_ALWAYS);
    expect(await readOrder(f.app, orderId)).toMatchObject({ total: '0.3875', open_line_count: 2 });
  });

  it('[FR-PO-04] an insert carrying a total, line total or received quantity is refused', async () => {
    const { f } = await setup();
    expect(
      await asApp(
        f,
        `INSERT INTO purchase_orders (id, owner_id, vendor_id, total) VALUES ($1, $2, $3, 5)`,
        [randomUUID(), f.buyerId, f.vendorId],
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    for (const [column, refusal] of [
      ['line_total', GENERATED_ALWAYS],
      ['received_quantity', INSUFFICIENT_PRIVILEGE],
    ] as const) {
      expect(
        await asApp(
          f,
          `INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price, ${column})
           VALUES (gen_random_uuid(), $1, 1, 'Extra', 1, 1, 1)`,
          [orderId],
        ),
        column,
      ).toBe(refusal);
    }
  });

  it('[FR-PO-04] lines changed without touching the order still move its total', async () => {
    const { f, orderId, lineIds } = await setup();
    await inTransaction(f.app, (q) =>
      insertLines(q, orderId, [{ quantity: 2, unitPrice: '0.5' }], 2),
    );
    expect(await readOrder(f.app, orderId)).toMatchObject({ total: '1.3875', open_line_count: 3 });
    await inTransaction(f.app, (q) =>
      q.query(`UPDATE order_lines SET quantity = quantity * 2 WHERE order_id = $1`, [orderId]),
    );
    expect(await readOrder(f.app, orderId)).toMatchObject({ total: '2.7750' });
    await inTransaction(f.app, (q) =>
      q.query(`DELETE FROM order_lines WHERE id = $1`, [lineIds[0]]),
    );
    expect(await readOrder(f.app, orderId)).toMatchObject({ total: '2.1750', open_line_count: 2 });
  });

  it('[FR-PO-03] deleting the last line, or moving every line away, is refused at commit', async () => {
    const { f, orderId } = await setup();
    const other = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    expect(await asApp(f, `DELETE FROM order_lines WHERE order_id = $1`, [orderId])).toBe(
      ORDER_WITHOUT_LINES,
    );
    // order_id isn't updatable by po_app: a line can't be moved to another order.
    expect(
      await asApp(f, `UPDATE order_lines SET order_id = $2 WHERE order_id = $1`, [
        orderId,
        other.orderId,
      ]),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("[FR-PO-05] a PO number, once given, can't be changed or cleared", async () => {
    const { f, orderId } = await setup();
    expect(
      await asApp(f, `UPDATE purchase_orders SET po_number = 'PO-2026-27-999999' WHERE id = $1`, [
        orderId,
      ]),
    ).toBe(ORDER_FIELD_IMMUTABLE);
    expect(
      await asApp(f, `UPDATE purchase_orders SET po_number = NULL WHERE id = $1`, [orderId]),
    ).toBe(ORDER_FIELD_IMMUTABLE);
  });

  it("[FR-PO-04] the guards can't be switched off or gone around by the application role", async () => {
    const { f, orderId } = await setup();
    expect(await asApp(f, `ALTER TABLE purchase_orders DISABLE TRIGGER USER`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await asApp(f, `SET LOCAL session_replication_role = replica`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await asApp(f, `TRUNCATE order_lines`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await asApp(f, `SELECT recompute_orders(ARRAY[$1::uuid])`, [orderId])).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    // Setting the recompute flag by hand gives no column privilege.
    expect(
      await sqlstate(() =>
        inTransaction(f.app, async (q) => {
          await q.query(`SELECT set_config('po.recompute', txid_current()::text, true)`);
          await q.query(`UPDATE purchase_orders SET total = 0 WHERE id = $1`, [orderId]);
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('[FR-PO-07] fractional prices never drift: 498 lines of 3 × 0.0001 sum exactly', async () => {
    const { f, orderId } = await setup();
    await inTransaction(f.app, (q) =>
      insertLines(
        q,
        orderId,
        Array.from({ length: 498 }, () => ({ quantity: 1, unitPrice: '0.0001' })),
        2,
      ),
    );
    await inTransaction(f.app, (q) =>
      q.query(`UPDATE order_lines SET quantity = 3 WHERE order_id = $1 AND unit_price = 0.0001`, [
        orderId,
      ]),
    );
    expect(await readOrder(f.app, orderId)).toMatchObject({
      total: '0.5369',
      open_line_count: 500,
    });
  });

  it('[FR-PO-07] values at the limits fit without overflow', async () => {
    const { f } = await setup();
    const { orderId } = await createDraft(
      f,
      Array.from({ length: 500 }, () => ({ quantity: 1_000_000, unitPrice: '999999999.9999' })),
    );
    expect(await readOrder(f.app, orderId)).toMatchObject({
      total: '499999999999950000.0000',
      open_line_count: 500,
    });
  });
});

describe('[FR-PO-04] attacks as the privileged owner role (po_owner)', () => {
  it('[FR-PO-04] a direct write of the total or open-line count is DERIVED_VALUE_READ_ONLY', async () => {
    const { f, orderId } = await setup();
    expect(
      await asOwner(f, `UPDATE purchase_orders SET total = 999 WHERE id = $1`, [orderId]),
    ).toBe(DERIVED_VALUE_READ_ONLY);
    expect(
      await asOwner(f, `UPDATE purchase_orders SET open_line_count = 0 WHERE id = $1`, [orderId]),
    ).toBe(DERIVED_VALUE_READ_ONLY);
    expect(
      await asOwner(f, `UPDATE purchase_orders SET total = total + 1, version = version + 1`),
    ).toBe(DERIVED_VALUE_READ_ONLY);
  });

  it('[FR-PO-04] an order inserted with a total or open-line count is DERIVED_VALUE_READ_ONLY', async () => {
    const { f } = await setup();
    for (const column of ['total', 'open_line_count']) {
      expect(
        await asOwner(
          f,
          `INSERT INTO purchase_orders (id, owner_id, vendor_id, ${column}) VALUES ($1, $2, $3, 5)`,
          [randomUUID(), f.buyerId, f.vendorId],
        ),
        column,
      ).toBe(DERIVED_VALUE_READ_ONLY);
    }
  });

  it("[FR-PO-04] a line total can't be written, even by the owner", async () => {
    const { f, orderId } = await setup();
    expect(
      await asOwner(f, `UPDATE order_lines SET line_total = 0 WHERE order_id = $1`, [orderId]),
    ).toBe(GENERATED_ALWAYS);
  });

  it('[FR-SM-02] a status change outside the transition table is refused', async () => {
    const { f, orderId } = await setup();
    expect(
      await asOwner(f, `UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`, [orderId]),
    ).toBe(ORDER_STATUS_TRANSITION_REFUSED);
  });
});
