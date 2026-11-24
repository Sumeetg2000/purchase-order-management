import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_CONTEXT_REQUIRED,
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  orderFixture,
  plant,
  sqlstate,
  type OrderFixture,
} from '../support/orders-sql.js';
import {
  FOREIGN_KEY_VIOLATION,
  approvedOrder,
  asActor,
  buyer,
  insertReceipts,
  receiptCount,
} from '../support/receipts-sql.js';
import { plantsViolations } from '../support/setup.js';

// Migration 0016, part 1 (specs/007-goods-receipt/data-model.md, research R1, R10): the
// receipts table, its checks, keys, indexes and grants, the actor-context trigger, and
// the idempotency operation CHECK widened. The rules (D12–D17) are part 2, tested by
// receipt-triggers.test.ts.

/** Plants one receipt below the triggers (CHECKs still apply), as the superuser. */
async function plantReceipt(
  f: OrderFixture,
  orderId: string,
  lineId: string,
  values: { quantity?: number; note?: string | null } = {},
): Promise<string | undefined> {
  return sqlstate(() =>
    plant(
      f,
      `INSERT INTO receipts (order_id, line_id, quantity, received_at, recorded_by, note)
       VALUES ($1, $2, $3, current_date, $4, $5)`,
      [orderId, lineId, values.quantity ?? 1, f.buyerId, values.note ?? null],
    ),
  );
}

describe('[FR-RCV-01] migration 0016: the receipts table', () => {
  it('[FR-RCV-01] receipts has its columns, types and nullability', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'receipts'
        ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => [r.column_name, r.data_type, r.is_nullable])).toEqual([
      ['id', 'uuid', 'NO'],
      ['order_id', 'uuid', 'NO'],
      ['line_id', 'uuid', 'NO'],
      ['quantity', 'integer', 'NO'],
      ['received_at', 'date', 'NO'],
      ['recorded_at', 'timestamp with time zone', 'NO'],
      ['recorded_by', 'uuid', 'NO'],
      ['note', 'text', 'YES'],
    ]);
    expect(rows[0]?.column_default).toBe('gen_random_uuid()');
  });

  it("[FR-RCV-01] a receipt's line is on its order: the composite key, and the unique key it targets", async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE (conrelid = 'public.receipts'::regclass AND contype IN ('f', 'c'))
           OR conname = 'order_lines_id_order_key'
        ORDER BY conname`,
    );
    expect(rows.map((r) => [r.conname, r.def])).toEqual([
      ['order_lines_id_order_key', 'UNIQUE (id, order_id)'],
      [
        'receipts_line_fkey',
        'FOREIGN KEY (line_id, order_id) REFERENCES order_lines(id, order_id) ON DELETE RESTRICT',
      ],
      [
        'receipts_note_valid',
        expect.stringContaining('char_length(note) >= 1') as unknown as string,
      ],
      ['receipts_quantity_range', 'CHECK (((quantity >= 1) AND (quantity <= 1000000)))'],
      ['receipts_recorded_by_fkey', 'FOREIGN KEY (recorded_by) REFERENCES users(id)'],
    ]);
  });

  it("[FR-RCV-01] a receipt naming another order's line is refused", async () => {
    const f = await orderFixture();
    const a = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const b = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const state = await sqlstate(() =>
      asActor(f.app, buyer(f), (q) =>
        insertReceipts(q, a.orderId, [{ lineId: b.lineIds[0] ?? '', quantity: 1 }]),
      ),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
    expect(await receiptCount(f.app, a.orderId)).toBe(0);
  });

  it('[NFR-VAL-01] quantity is a whole number from 1 to 1,000,000', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const lineId = lineIds[0] ?? '';
    expect(await plantReceipt(f, orderId, lineId, { quantity: 0 })).toBe(CHECK_VIOLATION);
    expect(await plantReceipt(f, orderId, lineId, { quantity: -1 })).toBe(CHECK_VIOLATION);
    expect(await plantReceipt(f, orderId, lineId, { quantity: 1_000_001 })).toBe(CHECK_VIOLATION);
    expect(await plantReceipt(f, orderId, lineId, { quantity: 1 })).toBeUndefined();
    expect(await plantReceipt(f, orderId, lineId, { quantity: 1_000_000 })).toBeUndefined();
  });

  it('[NFR-VAL-01] the note is trimmed plain text of 1 to 500 characters, line breaks allowed', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const note = (value: string | null) =>
      plantReceipt(f, orderId, lineIds[0] ?? '', { note: value });
    expect(await note('')).toBe(CHECK_VIOLATION);
    expect(await note(' Boxes dented')).toBe(CHECK_VIOLATION);
    expect(await note('x'.repeat(501))).toBe(CHECK_VIOLATION);
    expect(await note('Tab\there')).toBe(CHECK_VIOLATION);
    expect(await note('Bell\u0007')).toBe(CHECK_VIOLATION);
    expect(await note('C1\u0085control')).toBe(CHECK_VIOLATION);
    expect(await note(null)).toBeUndefined();
    expect(await note('x'.repeat(500))).toBeUndefined();
    expect(await note('😀'.repeat(500))).toBeUndefined();
    expect(await note('Line one\nline two\r\nline three')).toBeUndefined();
  });

  it('[NFR-PERF-01] the receipt indexes: history and badge, the line, the recorder', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'receipts' OR indexname = 'order_lines_id_order_key'
        ORDER BY indexname`,
    );
    expect(rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')])).toEqual([
      ['order_lines_id_order_key', '(id, order_id)'],
      ['receipts_line_idx', '(line_id)'],
      ['receipts_order_recorded_idx', '(order_id, recorded_at DESC, id DESC)'],
      ['receipts_pkey', '(id)'],
      ['receipts_recorded_by_idx', '(recorded_by)'],
    ]);
  });
});

describe('[FR-RCV-02] migration 0016: who may write receipts', () => {
  it('[FR-RCV-02] po_app reads receipts and inserts only the six caller columns; no update, delete or truncate', async () => {
    const { superuser: q } = await orderFixture();
    const table = await q.query<{ privilege: string; granted: boolean }>(
      `SELECT p AS privilege, has_table_privilege('po_app', 'public.receipts', p) AS granted
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p`,
    );
    expect(Object.fromEntries(table.rows.map((r) => [r.privilege, r.granted]))).toEqual({
      SELECT: true,
      INSERT: false,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    });
    const columns = await q.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'receipts'
          AND has_column_privilege('po_app', 'public.receipts', column_name, 'INSERT')
        ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      'order_id',
      'line_id',
      'quantity',
      'received_at',
      'recorded_by',
      'note',
    ]);
    const updatable = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'receipts'
          AND has_column_privilege('po_app', 'public.receipts', column_name, 'UPDATE')`,
    );
    expect(updatable.rows[0]?.n).toBe(0);
  });

  it('[FR-RCV-02] po_app cannot set the id or the recorded time', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    for (const [column, value] of [
      ['id', randomUUID()],
      ['recorded_at', '2020-01-01T00:00:00Z'],
    ] as const) {
      const state = await sqlstate(() =>
        asActor(f.app, buyer(f), (q) =>
          q.query(
            `INSERT INTO receipts (order_id, line_id, quantity, received_at, recorded_by, ${column})
             VALUES ($1, $2, 1, current_date, $3, $4)`,
            [orderId, lineIds[0], f.buyerId, value],
          ),
        ),
      );
      expect(state, column).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('[NFR-AUD-01] a receipt insert needs an actor context', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const state = await sqlstate(async () => {
      await f.app.query('BEGIN');
      try {
        await insertReceipts(f.app, orderId, [{ lineId: lineIds[0] ?? '', quantity: 1 }]);
      } finally {
        await f.app.query('ROLLBACK');
      }
    });
    expect(state).toBe(ACTOR_CONTEXT_REQUIRED);
    const { rows } = await f.superuser.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'public.receipts'::regclass AND tgname = 'require_actor_context'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('[NFR-CON-03] the idempotency operation CHECK accepts recordReceipt', async () => {
    const f = await orderFixture();
    const state = await sqlstate(() =>
      asActor(f.app, buyer(f), (q) =>
        q.query(
          `INSERT INTO idempotency_keys (user_id, operation, key, request_hash)
           VALUES ($1, 'recordReceipt', gen_random_uuid(), sha256('body'::bytea))`,
          [f.buyerId],
        ),
      ),
    );
    expect(state).toBeUndefined();
  });
});
