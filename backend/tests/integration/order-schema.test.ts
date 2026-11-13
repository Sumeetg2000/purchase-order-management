import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { plantsViolations } from '../support/setup.js';
import {
  ACTOR_CONTEXT_REQUIRED,
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  createDraft,
  inTransaction,
  insertLines,
  orderFixture,
  sqlstate,
  type OrderFixture,
} from '../support/orders-sql.js';

// Migration 0013, part 1 (data-model.md): the order tables, their CHECKs, grants and
// indexes, and po_financial_year. The derived-value and rule triggers are part 2, tested
// by order-triggers.test.ts and the integrity suite. The numbers in the CHECKs are pinned
// to the contract constants by order-constants.test.ts.

async function columnPrivileges(
  q: pg.Client,
  role: string,
  table: string,
  privilege: 'INSERT' | 'UPDATE',
): Promise<string[]> {
  const { rows } = await q.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $2
        AND has_column_privilege($1, format('public.%I', table_name), column_name, $3)
      ORDER BY column_name`,
    [role, table, privilege],
  );
  return rows.map((r) => r.column_name);
}

async function tablePrivileges(q: pg.Client, role: string, table: string): Promise<string[]> {
  const all = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  const held: string[] = [];
  for (const privilege of all) {
    const { rows } = await q.query<{ ok: boolean }>(
      `SELECT has_table_privilege($1, $2, $3) AS ok`,
      [role, `public.${table}`, privilege],
    );
    if (rows[0]?.ok === true) held.push(privilege);
  }
  return held;
}

/** A line insert as po_app inside a transaction that also creates its order. */
async function lineState(
  f: OrderFixture,
  line: { description: string; quantity: number; unitPrice: string; position?: number },
): Promise<string | undefined> {
  return sqlstate(() =>
    inTransaction(f.app, async (q) => {
      const orderId = randomUUID();
      await q.query(`INSERT INTO purchase_orders (id, owner_id, vendor_id) VALUES ($1, $2, $3)`, [
        orderId,
        f.buyerId,
        f.vendorId,
      ]);
      await q.query(
        `INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [orderId, line.position ?? 0, line.description, line.quantity, line.unitPrice],
      );
      // Roll back on purpose: only the CHECKs are under test here.
      throw Object.assign(new Error('rollback'), { code: 'OK' });
    }),
  );
}

describe('[FR-PO-01] migration 0013: order tables', () => {
  it('[FR-PO-01] po_app holds exactly the planned table and column grants', async () => {
    const { superuser: q } = await orderFixture();

    expect(await tablePrivileges(q, 'po_app', 'purchase_orders')).toEqual(['SELECT', 'DELETE']);
    expect(await columnPrivileges(q, 'po_app', 'purchase_orders', 'INSERT')).toEqual([
      'id',
      'owner_id',
      'vendor_id',
    ]);
    expect(await columnPrivileges(q, 'po_app', 'purchase_orders', 'UPDATE')).toEqual([
      'po_number',
      'vendor_id',
      'version',
    ]);

    expect(await tablePrivileges(q, 'po_app', 'order_lines')).toEqual(['SELECT', 'DELETE']);
    expect(await columnPrivileges(q, 'po_app', 'order_lines', 'INSERT')).toEqual([
      'description',
      'id',
      'order_id',
      'position',
      'quantity',
      'unit_price',
    ]);
    expect(await columnPrivileges(q, 'po_app', 'order_lines', 'UPDATE')).toEqual([
      'description',
      'position',
      'quantity',
      'unit_price',
    ]);

    expect(await tablePrivileges(q, 'po_app', 'po_number_counters')).toEqual(['SELECT', 'INSERT']);
    expect(await columnPrivileges(q, 'po_app', 'po_number_counters', 'UPDATE')).toEqual([
      'last_value',
    ]);
    expect(await tablePrivileges(q, 'po_app', 'order_status_transitions')).toEqual(['SELECT']);

    expect(await tablePrivileges(q, 'po_app', 'idempotency_keys')).toEqual(['SELECT', 'INSERT']);
    expect(await columnPrivileges(q, 'po_app', 'idempotency_keys', 'UPDATE')).toEqual([
      'response',
      'status',
    ]);
    expect(await tablePrivileges(q, 'po_maintenance', 'idempotency_keys')).toEqual([
      'SELECT',
      'DELETE',
    ]);
    for (const table of ['purchase_orders', 'order_lines', 'po_number_counters']) {
      expect(await tablePrivileges(q, 'po_maintenance', table), table).toEqual([]);
    }
  });

  it('[FR-PO-01] order and line CHECKs refuse out-of-range values', async () => {
    const f = await orderFixture();
    const ok = { description: 'Bolts', quantity: 1, unitPrice: '0' };
    expect(await lineState(f, ok)).toBe('OK');
    expect(await lineState(f, { ...ok, quantity: 1_000_000 })).toBe('OK');
    expect(await lineState(f, { ...ok, unitPrice: '999999999.9999' })).toBe('OK');
    expect(await lineState(f, { ...ok, position: 499 })).toBe('OK');
    expect(await lineState(f, { ...ok, description: '😀'.repeat(500) })).toBe('OK');

    expect(await lineState(f, { ...ok, quantity: 0 })).toBe(CHECK_VIOLATION);
    expect(await lineState(f, { ...ok, quantity: 1_000_001 })).toBe(CHECK_VIOLATION);
    expect(await lineState(f, { ...ok, unitPrice: '-0.0001' })).toBe(CHECK_VIOLATION);
    // numeric(13,4): ten integer digits overflow the type itself.
    expect(await lineState(f, { ...ok, unitPrice: '1000000000' })).toBe('22003');
    expect(await lineState(f, { ...ok, position: -1 })).toBe(CHECK_VIOLATION);
    expect(await lineState(f, { ...ok, position: 500 })).toBe(CHECK_VIOLATION);
    expect(await lineState(f, { ...ok, description: '' })).toBe(CHECK_VIOLATION);
    expect(await lineState(f, { ...ok, description: ' Bolts' })).toBe(CHECK_VIOLATION);
    expect(await lineState(f, { ...ok, description: 'a\tb' })).toBe(CHECK_VIOLATION);
    expect(await lineState(f, { ...ok, description: 'a\nb' })).toBe(CHECK_VIOLATION);
    expect(await lineState(f, { ...ok, description: '😀'.repeat(501) })).toBe(CHECK_VIOLATION);
  });

  it('[FR-PO-01] line_total is generated from quantity × unit_price, exactly', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [
      { quantity: 7, unitPrice: '0.0125' },
      { quantity: 1_000_000, unitPrice: '999999999.9999' },
    ]);
    const { rows } = await f.app.query<{ line_total: string }>(
      `SELECT line_total::text AS line_total FROM order_lines WHERE order_id = $1 ORDER BY position`,
      [orderId],
    );
    expect(rows.map((r) => r.line_total)).toEqual(['0.0875', '999999999999900.0000']);
    const { rows: generated } = await f.superuser.query<{ attgenerated: string }>(
      `SELECT attgenerated FROM pg_attribute
        WHERE attrelid = 'order_lines'::regclass AND attname = 'line_total'`,
    );
    expect(generated[0]?.attgenerated).toBe('s');
  });

  it('[FR-PO-01] an order defaults to DRAFT, version 1, total 0 and no open lines', async () => {
    const f = await orderFixture();
    // A bare order row, planted below the guards: no lines and no PO number.
    plantsViolations(f.db);
    const orderId = randomUUID();
    await inTransaction(f.superuser, async (q) => {
      await q.query(`SET LOCAL session_replication_role = replica`);
      await q.query(`INSERT INTO purchase_orders (id, owner_id, vendor_id) VALUES ($1, $2, $3)`, [
        orderId,
        f.buyerId,
        f.vendorId,
      ]);
    });
    const { rows } = await f.app.query<Record<string, unknown>>(
      `SELECT status, version, total::text AS total, open_line_count, po_number
         FROM purchase_orders WHERE id = $1`,
      [orderId],
    );
    expect(rows[0]).toEqual({
      status: 'DRAFT',
      version: 1,
      total: '0.0000',
      open_line_count: 0,
      po_number: null,
    });
  });

  it('[FR-PO-01] order status, PO number format and the derived columns are CHECKed', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    const asSuperuser = (sql: string) =>
      sqlstate(() =>
        inTransaction(f.superuser, async (q) => {
          await q.query(`SET LOCAL session_replication_role = replica`);
          await q.query(sql, [orderId]);
        }),
      );
    expect(await asSuperuser(`UPDATE purchase_orders SET status = 'SENT' WHERE id = $1`)).toBe(
      CHECK_VIOLATION,
    );
    expect(await asSuperuser(`UPDATE purchase_orders SET po_number = 'PO-1' WHERE id = $1`)).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await asSuperuser(`UPDATE purchase_orders SET po_number = 'PO-2026-27-12345' WHERE id = $1`),
    ).toBe(CHECK_VIOLATION);
    expect(
      await asSuperuser(
        `UPDATE purchase_orders SET po_number = 'PO-2026-27-1234567' WHERE id = $1`,
      ),
    ).toBeUndefined();
    expect(await asSuperuser(`UPDATE purchase_orders SET total = -1 WHERE id = $1`)).toBe(
      CHECK_VIOLATION,
    );
    expect(await asSuperuser(`UPDATE purchase_orders SET open_line_count = -1 WHERE id = $1`)).toBe(
      CHECK_VIOLATION,
    );
    expect(await asSuperuser(`UPDATE purchase_orders SET version = 0 WHERE id = $1`)).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await asSuperuser(
        `UPDATE order_lines SET received_quantity = quantity + 1 WHERE order_id = $1`,
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await asSuperuser(`UPDATE order_lines SET received_quantity = -1 WHERE order_id = $1`),
    ).toBe(CHECK_VIOLATION);
  });

  it('[FR-PO-05] PO numbers are unique, compared byte for byte', async () => {
    const f = await orderFixture();
    const first = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    const second = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    // As the superuser with triggers off: the immutability trigger would refuse first.
    expect(
      await sqlstate(() =>
        inTransaction(f.superuser, async (q) => {
          await q.query(`SET LOCAL session_replication_role = replica`);
          await q.query(`UPDATE purchase_orders SET po_number = $1 WHERE id = $2`, [
            first.poNumber,
            second.orderId,
          ]);
        }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    const { rows } = await f.superuser.query<{ collation: string }>(
      `SELECT collation_name AS collation FROM information_schema.columns
        WHERE table_name = 'purchase_orders' AND column_name = 'po_number'`,
    );
    expect(rows[0]?.collation).toBe('C');
  });

  it('[FR-PO-01] line positions are unique per order, checked at commit', async () => {
    const f = await orderFixture();
    const { orderId, lineIds } = await createDraft(f, [
      { quantity: 1, unitPrice: '1' },
      { quantity: 2, unitPrice: '1' },
    ]);
    // Swapping two positions one row at a time passes: the check is deferred.
    await inTransaction(f.app, async (q) => {
      await q.query(`UPDATE order_lines SET position = 1 WHERE id = $1`, [lineIds[0]]);
      await q.query(`UPDATE order_lines SET position = 0 WHERE id = $1`, [lineIds[1]]);
    });
    expect(
      await sqlstate(() =>
        inTransaction(f.app, (q) => insertLines(q, orderId, [{ quantity: 1, unitPrice: '1' }], 1)),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('[FR-PO-01] deleting an order deletes its lines', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    await inTransaction(f.app, (q) =>
      q.query(`DELETE FROM purchase_orders WHERE id = $1`, [orderId]),
    );
    const { rows } = await f.app.query(`SELECT 1 FROM order_lines WHERE order_id = $1`, [orderId]);
    expect(rows).toEqual([]);
  });

  it('[FR-PO-01] a statement on either order table without actor context is refused', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    const noContext = (sql: string) =>
      sqlstate(() => inTransaction(f.app, (q) => q.query(sql, [orderId]), { context: false }));
    expect(await noContext(`UPDATE purchase_orders SET version = version WHERE id = $1`)).toBe(
      ACTOR_CONTEXT_REQUIRED,
    );
    expect(await noContext(`DELETE FROM order_lines WHERE order_id = $1`)).toBe(
      ACTOR_CONTEXT_REQUIRED,
    );
  });

  it('[FR-PO-01] the counter, transition and idempotency tables refuse bad rows', async () => {
    const f = await orderFixture();
    const insert = (sql: string, params: unknown[] = []) =>
      sqlstate(() => inTransaction(f.app, (q) => q.query(sql, params)));
    expect(await insert(`INSERT INTO po_number_counters (fy, last_value) VALUES ('2026', 1)`)).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await insert(`INSERT INTO po_number_counters (fy, last_value) VALUES ('2026-27', 0)`),
    ).toBe(CHECK_VIOLATION);
    expect(await insert(`INSERT INTO order_status_transitions VALUES ('DRAFT', 'APPROVED')`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    const key = (operation: string, hashBytes: number) =>
      insert(
        `INSERT INTO idempotency_keys (user_id, operation, key, request_hash)
         VALUES ($1, $2, gen_random_uuid(), decode(repeat('ab', $3), 'hex'))`,
        [f.buyerId, operation, hashBytes],
      );
    expect(await key('createOrder', 32)).toBeUndefined();
    expect(await key('deleteOrder', 32)).toBe(CHECK_VIOLATION);
    expect(await key('createOrder', 31)).toBe(CHECK_VIOLATION);
    const { rows } = await f.app.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM order_status_transitions`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('[NFR-PERF-01] the order list indexes exist exactly as planned', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('purchase_orders', 'idempotency_keys') ORDER BY indexname`,
    );
    const defs = Object.fromEntries(
      rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')]),
    );
    expect(defs).toEqual({
      idempotency_keys_created_at_idx: '(created_at)',
      idempotency_keys_pkey: '(user_id, operation, key)',
      purchase_orders_created_idx: '(created_at DESC, id DESC)',
      purchase_orders_owner_created_idx: '(owner_id, created_at DESC, id DESC)',
      purchase_orders_owner_po_number_idx: '(owner_id, po_number)',
      purchase_orders_owner_status_created_idx: '(owner_id, status, created_at DESC, id DESC)',
      purchase_orders_owner_vendor_created_idx: '(owner_id, vendor_id, created_at DESC, id DESC)',
      purchase_orders_pkey: '(id)',
      purchase_orders_po_number_key: '(po_number)',
      purchase_orders_status_created_idx: '(status, created_at DESC, id DESC)',
      purchase_orders_vendor_created_idx: '(vendor_id, created_at DESC, id DESC)',
    });
  });

  it('[FR-PO-05] po_financial_year splits the year at 1 April 00:00 IST', async () => {
    const { app, superuser } = await orderFixture();
    const fy = async (ts: string) => {
      const { rows } = await app.query<{ fy: string }>(`SELECT po_financial_year($1) AS fy`, [ts]);
      return rows[0]?.fy;
    };
    expect(await fy('2026-03-31T23:59:59.999999+05:30')).toBe('2025-26');
    expect(await fy('2026-04-01T00:00:00+05:30')).toBe('2026-27');
    // 18:30 UTC on 31 March is already 1 April in India.
    expect(await fy('2026-03-31T18:30:00Z')).toBe('2026-27');
    expect(await fy('2099-12-31T12:00:00+05:30')).toBe('2099-00');

    const { rows } = await superuser.query<{
      volatile: string;
      app: boolean;
      maintenance: boolean;
    }>(
      `SELECT p.provolatile AS volatile,
              has_function_privilege('po_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('po_maintenance', p.oid, 'EXECUTE') AS maintenance
         FROM pg_proc p WHERE p.proname = 'po_financial_year'`,
    );
    expect(rows).toEqual([{ volatile: 's', app: true, maintenance: false }]);
  });
});
