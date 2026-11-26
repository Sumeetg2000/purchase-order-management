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
  UNIQUE_VIOLATION,
  approvedOrder,
  asActor,
  buyer,
  insertReceipt,
  receiptCount,
} from '../support/receipts-sql.js';
import { plantsViolations } from '../support/setup.js';

// Migration 0016, part 1 (specs/007-goods-receipt/data-model.md, research R1, R10): the
// receipt document, goods_receipts with its goods_receipt_lines, their checks, keys,
// indexes and grants, the actor-context triggers, and the idempotency operation CHECK
// widened. The rules (D12–D17) are part 2, tested by receipt-triggers.test.ts.

type Column = [name: string, type: string, nullable: string];

async function columns(f: OrderFixture, table: string) {
  const { rows } = await f.superuser.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return rows;
}

/** Plants one receipt header below the triggers (CHECKs still apply), as the superuser. */
async function plantHeader(f: OrderFixture, orderId: string, note: string | null) {
  return sqlstate(() =>
    plant(
      f,
      `INSERT INTO goods_receipts (order_id, received_on, recorded_by, note)
       VALUES ($1, current_date, $2, $3)`,
      [orderId, f.buyerId, note],
    ),
  );
}

/** Plants one receipt with one line of `quantity` below the triggers, as the superuser. */
async function plantLine(f: OrderFixture, orderId: string, lineId: string, quantity: number) {
  return sqlstate(() =>
    plant(
      f,
      `WITH r AS (
         INSERT INTO goods_receipts (order_id, received_on, recorded_by)
         VALUES ($1, current_date, $3) RETURNING id, order_id
       )
       INSERT INTO goods_receipt_lines (receipt_id, order_id, line_id, quantity)
       SELECT r.id, r.order_id, $2, $4 FROM r`,
      [orderId, lineId, f.buyerId, quantity],
    ),
  );
}

describe('[FR-RCV-01] migration 0016: the receipt document', () => {
  it('[FR-RCV-01] goods_receipts has its columns, types and nullability', async () => {
    const rows = await columns(await orderFixture(), 'goods_receipts');
    expect(rows.map((r): Column => [r.column_name, r.data_type, r.is_nullable])).toEqual([
      ['id', 'uuid', 'NO'],
      ['order_id', 'uuid', 'NO'],
      ['received_on', 'date', 'NO'],
      ['recorded_at', 'timestamp with time zone', 'NO'],
      ['recorded_by', 'uuid', 'NO'],
      ['note', 'text', 'YES'],
    ]);
    expect(rows[0]?.column_default).toBe('gen_random_uuid()');
  });

  it('[FR-RCV-01] goods_receipt_lines has its columns, types and nullability', async () => {
    const rows = await columns(await orderFixture(), 'goods_receipt_lines');
    expect(rows.map((r): Column => [r.column_name, r.data_type, r.is_nullable])).toEqual([
      ['receipt_id', 'uuid', 'NO'],
      ['order_id', 'uuid', 'NO'],
      ['line_id', 'uuid', 'NO'],
      ['quantity', 'integer', 'NO'],
    ]);
  });

  it("[FR-RCV-01] every receipt line is on its receipt's order and that order's line: the keys", async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid IN ('public.goods_receipts'::regclass, 'public.goods_receipt_lines'::regclass)
           OR conname = 'order_lines_id_order_key'
        ORDER BY conname`,
    );
    expect(rows.map((r) => [r.conname, r.def])).toEqual([
      ['goods_receipt_lines_line_fkey', expect.any(String)],
      ['goods_receipt_lines_pkey', 'PRIMARY KEY (receipt_id, line_id)'],
      ['goods_receipt_lines_quantity_range', expect.any(String)],
      ['goods_receipt_lines_receipt_fkey', expect.any(String)],
      ['goods_receipts_id_order_key', 'UNIQUE (id, order_id)'],
      ['goods_receipts_note_valid', expect.any(String)],
      ['goods_receipts_order_fkey', expect.any(String)],
      ['goods_receipts_pkey', 'PRIMARY KEY (id)'],
      ['goods_receipts_recorded_by_fkey', 'FOREIGN KEY (recorded_by) REFERENCES users(id)'],
      ['order_lines_id_order_key', 'UNIQUE (id, order_id)'],
    ]);
    const def = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
    expect(def.goods_receipt_lines_line_fkey).toBe(
      'FOREIGN KEY (line_id, order_id) REFERENCES order_lines(id, order_id) ON DELETE RESTRICT',
    );
    expect(def.goods_receipt_lines_receipt_fkey).toBe(
      'FOREIGN KEY (receipt_id, order_id) REFERENCES goods_receipts(id, order_id) ON DELETE RESTRICT',
    );
    expect(def.goods_receipts_order_fkey).toBe(
      'FOREIGN KEY (order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT',
    );
    expect(def.goods_receipt_lines_quantity_range).toBe(
      'CHECK (((quantity >= 1) AND (quantity <= 1000000)))',
    );
    expect(def.goods_receipts_note_valid).toContain('char_length(note) >= 1');
  });

  it("[FR-RCV-01] a receipt line naming another order's line is refused", async () => {
    const f = await orderFixture();
    const a = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const b = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const state = await sqlstate(() =>
      asActor(f.app, buyer(f), (q) =>
        insertReceipt(q, a.orderId, [{ lineId: b.lineIds[0] ?? '', quantity: 1 }]),
      ),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
    expect(await receiptCount(f.app, a.orderId)).toEqual({ receipts: 0, lines: 0 });
  });

  it("[FR-RCV-01] a receipt line on another order's receipt is refused, even naming that order's line", async () => {
    const f = await orderFixture();
    const a = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const b = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const state = await sqlstate(() =>
      asActor(f.app, buyer(f), (q) =>
        q.query(
          `WITH r AS (
             INSERT INTO goods_receipts (order_id, received_on, recorded_by)
             VALUES ($1, (now() AT TIME ZONE 'Asia/Kolkata')::date, $3) RETURNING id
           )
           INSERT INTO goods_receipt_lines (receipt_id, order_id, line_id, quantity)
           SELECT r.id, $2, $4, 1 FROM r`,
          [a.orderId, b.orderId, f.buyerId, b.lineIds[0]],
        ),
      ),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
    expect(await receiptCount(f.app, b.orderId)).toEqual({ receipts: 0, lines: 0 });
  });

  it('[FR-RCV-01] a receipt names a line once', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const lineId = lineIds[0] ?? '';
    const state = await sqlstate(() =>
      asActor(f.app, buyer(f), (q) =>
        insertReceipt(q, orderId, [
          { lineId, quantity: 1 },
          { lineId, quantity: 1 },
        ]),
      ),
    );
    expect(state).toBe(UNIQUE_VIOLATION);
    expect(await receiptCount(f.app, orderId)).toEqual({ receipts: 0, lines: 0 });
  });

  it('[NFR-VAL-01] a receipt line quantity is a whole number from 1 to 1,000,000', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const line = (quantity: number) => plantLine(f, orderId, lineIds[0] ?? '', quantity);
    expect(await line(0)).toBe(CHECK_VIOLATION);
    expect(await line(-1)).toBe(CHECK_VIOLATION);
    expect(await line(1_000_001)).toBe(CHECK_VIOLATION);
    expect(await line(1)).toBeUndefined();
    expect(await line(1_000_000)).toBeUndefined();
  });

  it('[NFR-VAL-01] the note is trimmed plain text of 1 to 500 characters, line breaks allowed', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const { orderId } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const note = (value: string | null) => plantHeader(f, orderId, value);
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

  it('[NFR-PERF-01] the receipt indexes: history and badge, the recorder, the line', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('goods_receipts', 'goods_receipt_lines')
           OR indexname = 'order_lines_id_order_key'
        ORDER BY indexname`,
    );
    expect(rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')])).toEqual([
      ['goods_receipt_lines_line_idx', '(line_id)'],
      ['goods_receipt_lines_pkey', '(receipt_id, line_id)'],
      ['goods_receipts_id_order_key', '(id, order_id)'],
      ['goods_receipts_order_recorded_idx', '(order_id, recorded_at DESC, id DESC)'],
      ['goods_receipts_pkey', '(id)'],
      ['goods_receipts_recorded_by_idx', '(recorded_by)'],
      ['order_lines_id_order_key', '(id, order_id)'],
    ]);
  });
});

describe('[FR-RCV-02] migration 0016: who may write receipts', () => {
  for (const [table, insertable] of [
    ['goods_receipts', ['order_id', 'received_on', 'recorded_by', 'note']],
    ['goods_receipt_lines', ['receipt_id', 'order_id', 'line_id', 'quantity']],
  ] as const) {
    it(`[FR-RCV-02] po_app reads ${table} and inserts only its caller columns; no update, delete or truncate`, async () => {
      const { superuser: q } = await orderFixture();
      const privileges = await q.query<{ privilege: string; granted: boolean }>(
        `SELECT p AS privilege, has_table_privilege('po_app', 'public.' || $1, p) AS granted
           FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p`,
        [table],
      );
      expect(Object.fromEntries(privileges.rows.map((r) => [r.privilege, r.granted]))).toEqual({
        SELECT: true,
        INSERT: false,
        UPDATE: false,
        DELETE: false,
        TRUNCATE: false,
      });
      const granted = await q.query<{ column_name: string; privilege: string }>(
        `SELECT column_name, p AS privilege
           FROM information_schema.columns, unnest(ARRAY['INSERT', 'UPDATE']) AS p
          WHERE table_schema = 'public' AND table_name = $1
            AND has_column_privilege('po_app', 'public.' || $1, column_name, p)
          ORDER BY p, ordinal_position`,
        [table],
      );
      expect(granted.rows.map((r) => `${r.privilege} ${r.column_name}`)).toEqual(
        insertable.map((c) => `INSERT ${c}`),
      );
    });
  }

  it('[FR-RCV-02] po_app cannot set the receipt id or the recorded time', async () => {
    const f = await orderFixture();
    const { orderId } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    for (const [column, value] of [
      ['id', randomUUID()],
      ['recorded_at', '2020-01-01T00:00:00Z'],
    ] as const) {
      const state = await sqlstate(() =>
        asActor(f.app, buyer(f), (q) =>
          q.query(
            `INSERT INTO goods_receipts (order_id, received_on, recorded_by, ${column})
             VALUES ($1, current_date, $2, $3)`,
            [orderId, f.buyerId, value],
          ),
        ),
      );
      expect(state, column).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('[NFR-AUD-01] a receipt insert needs an actor context, on both tables', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const state = await sqlstate(async () => {
      await f.app.query('BEGIN');
      try {
        await insertReceipt(f.app, orderId, [{ lineId: lineIds[0] ?? '', quantity: 1 }]);
      } finally {
        await f.app.query('ROLLBACK');
      }
    });
    expect(state).toBe(ACTOR_CONTEXT_REQUIRED);
    const { rows } = await f.superuser.query<{ relname: string }>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'require_actor_context'
          AND c.relname IN ('goods_receipts', 'goods_receipt_lines')
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual(['goods_receipt_lines', 'goods_receipts']);
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
