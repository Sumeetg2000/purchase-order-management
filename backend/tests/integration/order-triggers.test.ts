import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DERIVED_VALUE_READ_ONLY,
  ORDER_DELETE_REFUSED,
  ORDER_FIELD_IMMUTABLE,
  ORDER_LINES_LOCKED,
  ORDER_STATUS_TRANSITION_REFUSED,
  ORDER_WITHOUT_LINES,
  PO_NUMBER_UNASSIGNED,
  assignPoNumber,
  createDraft,
  inTransaction,
  insertLines,
  orderFixture,
  plant,
  readOrder,
  sqlstate,
  type OrderFixture,
} from '../support/orders-sql.js';

// Migration 0013, part 2 (data-model.md, research R3 and R4): the database keeps every
// order's total and open-line count, an order always has a line and a PO number, and only
// drafts change. Raw SQL as po_app (with actor context) unless a test says otherwise.

async function recomputeCount(f: OrderFixture, work: (q: OrderFixture['app']) => Promise<unknown>) {
  return inTransaction(f.app, async (q) => {
    await work(q);
    const { rows } = await q.query<{ n: string | null }>(
      `SELECT current_setting('po.recompute_count', true) AS n`,
    );
    return Number(rows[0]?.n ?? 0);
  });
}

/** Makes an order non-draft below every guard, as only later slices' transitions will. */
async function makeApproved(f: OrderFixture, orderId: string) {
  await plant(f, `UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`, [orderId]);
}

describe('[FR-PO-03] the database keeps order totals and open-line counts', () => {
  it('[FR-PO-03] inserting lines sets the total and open-line count in the same transaction', async () => {
    const f = await orderFixture();
    const totals = await inTransaction(f.app, async (q) => {
      const { orderId } = await (async () => {
        const id = randomUUID();
        await q.query(`INSERT INTO purchase_orders (id, owner_id, vendor_id) VALUES ($1, $2, $3)`, [
          id,
          f.buyerId,
          f.vendorId,
        ]);
        return { orderId: id };
      })();
      await insertLines(q, orderId, [
        { quantity: 1, unitPrice: '0.1' },
        { quantity: 1, unitPrice: '0.1' },
        { quantity: 1, unitPrice: '0.1' },
      ]);
      const inside = await readOrder(q, orderId);
      await assignPoNumber(q, orderId);
      return inside;
    });
    expect(totals).toMatchObject({ total: '0.3000', open_line_count: 3 });
  });

  it('[FR-PO-04] updating quantity or unit price, and deleting a line, follow at once', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await createDraft(f, [
      { quantity: 2, unitPrice: '5' },
      { quantity: 7, unitPrice: '0.0125' },
    ]);
    await inTransaction(f.app, (q) =>
      q.query(`UPDATE order_lines SET quantity = 3 WHERE id = $1`, [lineIds[0]]),
    );
    expect(await readOrder(f.app, orderId)).toMatchObject({ total: '15.0875', open_line_count: 2 });
    await inTransaction(f.app, (q) =>
      q.query(`UPDATE order_lines SET unit_price = 0 WHERE id = $1`, [lineIds[1]]),
    );
    expect(await readOrder(f.app, orderId)).toMatchObject({ total: '15.0000' });
    await inTransaction(f.app, (q) =>
      q.query(`DELETE FROM order_lines WHERE id = $1`, [lineIds[1]]),
    );
    expect(await readOrder(f.app, orderId)).toMatchObject({ total: '15.0000', open_line_count: 1 });
  });

  it('[NFR-PERF-03] a description- or position-only update recomputes nothing', async () => {
    const f = await orderFixture();
    const { lineIds } = await createDraft(f, [
      { quantity: 2, unitPrice: '5' },
      { quantity: 1, unitPrice: '5' },
    ]);
    expect(
      await recomputeCount(f, (q) =>
        q.query(`UPDATE order_lines SET description = 'Renamed' WHERE id = $1`, [lineIds[0]]),
      ),
    ).toBe(0);
    expect(
      await recomputeCount(f, (q) =>
        q.query(`UPDATE order_lines SET position = 1 - position WHERE id = ANY($1)`, [lineIds]),
      ),
    ).toBe(0);
  });
});

describe('[FR-PO-03] an order always has at least one line', () => {
  it('[FR-PO-03] deleting the last line fails at commit; replacing every line commits', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    expect(
      await sqlstate(() =>
        inTransaction(f.app, (q) =>
          q.query(`DELETE FROM order_lines WHERE order_id = $1`, [orderId]),
        ),
      ),
    ).toBe(ORDER_WITHOUT_LINES);
    await inTransaction(f.app, async (q) => {
      await q.query(`DELETE FROM order_lines WHERE id = $1`, [lineIds[0]]);
      await insertLines(q, orderId, [{ quantity: 4, unitPrice: '2.5' }]);
    });
    expect(await readOrder(f.app, orderId)).toMatchObject({ total: '10.0000', open_line_count: 1 });
  });

  it('[FR-PO-03] an order inserted without lines fails at commit', async () => {
    const f = await orderFixture();
    expect(
      await sqlstate(() =>
        inTransaction(f.app, async (q) => {
          const id = randomUUID();
          await q.query(
            `INSERT INTO purchase_orders (id, owner_id, vendor_id) VALUES ($1, $2, $3)`,
            [id, f.buyerId, f.vendorId],
          );
          await assignPoNumber(q, id);
        }),
      ),
    ).toBe(ORDER_WITHOUT_LINES);
  });
});

describe('[FR-PO-05] PO numbers are assigned once and never change', () => {
  it('[FR-PO-05] an order committed without a PO number fails at commit', async () => {
    const f = await orderFixture();
    expect(
      await sqlstate(() =>
        inTransaction(f.app, async (q) => {
          const id = randomUUID();
          await q.query(
            `INSERT INTO purchase_orders (id, owner_id, vendor_id) VALUES ($1, $2, $3)`,
            [id, f.buyerId, f.vendorId],
          );
          await insertLines(q, id, [{ quantity: 1, unitPrice: '1' }]);
        }),
      ),
    ).toBe(PO_NUMBER_UNASSIGNED);
  });

  it('[FR-PO-05] once set, the PO number, owner and creation time are immutable', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    const attempt = (sql: string, params: unknown[] = []) =>
      sqlstate(() => inTransaction(f.app, (q) => q.query(sql, [orderId, ...params])));
    expect(
      await attempt(`UPDATE purchase_orders SET po_number = 'PO-2026-27-999999' WHERE id = $1`),
    ).toBe(ORDER_FIELD_IMMUTABLE);
    expect(await attempt(`UPDATE purchase_orders SET po_number = NULL WHERE id = $1`)).toBe(
      ORDER_FIELD_IMMUTABLE,
    );
    // owner_id and created_at aren't granted to po_app; the owner role meets the trigger.
    const asOwner = (sql: string) =>
      sqlstate(() => inTransaction(f.owner, (q) => q.query(sql, [orderId])));
    expect(
      await asOwner(`UPDATE purchase_orders SET owner_id = gen_random_uuid() WHERE id = $1`),
    ).toBe(ORDER_FIELD_IMMUTABLE);
    expect(
      await asOwner(
        `UPDATE purchase_orders SET created_at = now() - interval '1 day' WHERE id = $1`,
      ),
    ).toBe(ORDER_FIELD_IMMUTABLE);
  });
});

describe('[FR-SM-02] only drafts change, and status changes only by the transition table', () => {
  it('[FR-SM-02] a status change of a draft is refused (no transition exists yet)', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    expect(
      await sqlstate(() =>
        inTransaction(f.owner, (q) =>
          q.query(`UPDATE purchase_orders SET status = 'PENDING_APPROVAL' WHERE id = $1`, [
            orderId,
          ]),
        ),
      ),
    ).toBe(ORDER_STATUS_TRANSITION_REFUSED);
  });

  it("[FR-SM-02] lines of a non-draft order can't be inserted, changed or deleted", async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await createDraft(f, [
      { quantity: 1, unitPrice: '1' },
      { quantity: 2, unitPrice: '1' },
    ]);
    await makeApproved(f, orderId);
    const attempt = (work: (q: OrderFixture['app']) => Promise<unknown>) =>
      sqlstate(() => inTransaction(f.app, work));
    expect(
      await attempt((q) => insertLines(q, orderId, [{ quantity: 1, unitPrice: '1' }], 2)),
    ).toBe(ORDER_LINES_LOCKED);
    expect(
      await attempt((q) =>
        q.query(`UPDATE order_lines SET quantity = 9 WHERE id = $1`, [lineIds[0]]),
      ),
    ).toBe(ORDER_LINES_LOCKED);
    expect(
      await attempt((q) => q.query(`DELETE FROM order_lines WHERE id = $1`, [lineIds[1]])),
    ).toBe(ORDER_LINES_LOCKED);
  });

  it('[FR-SM-02] only a draft can be deleted', async () => {
    const f = await orderFixture();
    const draft = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    const approved = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    await makeApproved(f, approved.orderId);
    expect(
      await sqlstate(() =>
        inTransaction(f.app, (q) =>
          q.query(`DELETE FROM purchase_orders WHERE id = $1`, [approved.orderId]),
        ),
      ),
    ).toBe(ORDER_DELETE_REFUSED);
    await inTransaction(f.app, (q) =>
      q.query(`DELETE FROM purchase_orders WHERE id = $1`, [draft.orderId]),
    );
    expect(await readOrder(f.app, draft.orderId)).toBeUndefined();
  });
});

describe('[FR-PO-04] derived values are written only by the recompute', () => {
  it('[FR-PO-04] a privileged write of the total or open-line count is DERIVED_VALUE_READ_ONLY', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    for (const set of ['total = 999', 'open_line_count = 7', 'total = total']) {
      expect(
        await sqlstate(() =>
          inTransaction(f.owner, (q) =>
            q.query(`UPDATE purchase_orders SET ${set} WHERE id = $1`, [orderId]),
          ),
        ),
        set,
      ).toBe(set === 'total = total' ? undefined : DERIVED_VALUE_READ_ONLY);
    }
  });

  it('[FR-PO-04] status-, vendor-, version- and timestamp-only updates pass and recompute nothing', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    expect(
      await recomputeCount(f, (q) =>
        q.query(
          `UPDATE purchase_orders SET vendor_id = vendor_id, version = version + 1 WHERE id = $1`,
          [orderId],
        ),
      ),
    ).toBe(0);
    await inTransaction(f.owner, (q) =>
      q.query(`UPDATE purchase_orders SET updated_at = now(), status = status WHERE id = $1`, [
        orderId,
      ]),
    );
    expect(await readOrder(f.app, orderId)).toMatchObject({ version: 2, total: '1.0000' });
  });
});
