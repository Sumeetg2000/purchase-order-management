import { describe, expect, it } from 'vitest';
import {
  CHECK_VIOLATION,
  createDraft,
  orderFixture,
  plant,
  plantSubmitted,
  sqlstate,
} from '../support/orders-sql.js';
import { plantsViolations } from '../support/setup.js';

// Migration 0015, part 1 (specs/006-lock-cancel/data-model.md): the cancel record as three
// columns on purchase_orders, all set exactly when the order is cancelled, with the reason
// rule of a withdrawal; the cancel transition; the canceller's foreign-key index. The guard
// and the commit-time branch are part 2, tested by approval-triggers.test.ts.

/** An approved order and its (planted) Approver, below the guards. */
async function approvedOrder(
  f: Awaited<ReturnType<typeof orderFixture>>,
): Promise<{ orderId: string; approverId: string }> {
  const { orderId } = await createDraft(f, [{ quantity: 2, unitPrice: '10' }]);
  const { approverId } = await plantSubmitted(f, orderId, 'APPROVED');
  return { orderId, approverId };
}

describe('[FR-LCK-02] migration 0015: the cancel record', () => {
  it('[FR-LCK-02] purchase_orders gains the three cancel columns, the canceller a user', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'purchase_orders'
          AND column_name IN ('cancelled_by', 'cancelled_at', 'cancel_reason')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'cancel_reason', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'cancelled_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'cancelled_by', data_type: 'uuid', is_nullable: 'YES' },
    ]);
    const fk = await q.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.purchase_orders'::regclass
          AND conname = 'purchase_orders_cancelled_by_fkey'`,
    );
    expect(fk.rows[0]?.def).toBe('FOREIGN KEY (cancelled_by) REFERENCES users(id)');
  });

  it('[FR-LCK-02] the record is set exactly when the order is cancelled', async () => {
    const f = await orderFixture();
    // CHECKs only: rows planted below the guards.
    plantsViolations(f.db);
    const { orderId, approverId } = await approvedOrder(f);
    const set = (assignments: string, params: unknown[] = []) =>
      sqlstate(() =>
        plant(f, `UPDATE purchase_orders SET ${assignments} WHERE id = $1`, [orderId, ...params]),
      );
    // Cancelled with no record, or part of one.
    expect(await set(`status = 'CANCELLED'`)).toBe(CHECK_VIOLATION);
    expect(
      await set(`status = 'CANCELLED', cancelled_by = $2, cancelled_at = now()`, [approverId]),
    ).toBe(CHECK_VIOLATION);
    expect(await set(`status = 'CANCELLED', cancel_reason = 'Not needed'`)).toBe(CHECK_VIOLATION);
    // A record on an order that isn't cancelled.
    expect(
      await set(`cancelled_by = $2, cancelled_at = now(), cancel_reason = 'Not needed'`, [
        approverId,
      ]),
    ).toBe(CHECK_VIOLATION);
    // The whole record with the status.
    expect(
      await set(
        `status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), cancel_reason = 'Not needed'`,
        [approverId],
      ),
    ).toBeUndefined();
  });

  it('[FR-LCK-02] the reason follows the withdrawal rule: trimmed, 1 to 500 characters', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const { orderId, approverId } = await approvedOrder(f);
    const cancel = (reason: string) =>
      sqlstate(() =>
        plant(
          f,
          `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_by = $2,
                  cancelled_at = now(), cancel_reason = $3 WHERE id = $1`,
          [orderId, approverId, reason],
        ),
      );
    expect(await cancel('')).toBe(CHECK_VIOLATION);
    expect(await cancel('   ')).toBe(CHECK_VIOLATION);
    expect(await cancel(' Not needed')).toBe(CHECK_VIOLATION);
    expect(await cancel('x'.repeat(501))).toBe(CHECK_VIOLATION);
    expect(await cancel('Line one\nline two')).toBeUndefined();
    await plant(
      f,
      `UPDATE purchase_orders SET status = 'APPROVED', cancelled_by = NULL, cancelled_at = NULL,
              cancel_reason = NULL WHERE id = $1`,
      [orderId],
    );
    expect(await cancel('x'.repeat(500))).toBeUndefined();
  });

  it('[FR-SM-01] the named CHECKs exist', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.purchase_orders'::regclass AND conname LIKE '%cancel%'
        ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      'purchase_orders_cancel_matches_status',
      'purchase_orders_cancel_reason_valid',
      'purchase_orders_cancelled_by_fkey',
    ]);
  });

  it("[NFR-PERF-01] the canceller's foreign key has its partial index, and no filter index is added", async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'purchase_orders' AND indexdef ILIKE '%cancel%'`,
    );
    expect(rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')])).toEqual([
      ['purchase_orders_cancelled_by_idx', '(cancelled_by) WHERE (cancelled_by IS NOT NULL)'],
    ]);
  });
});
