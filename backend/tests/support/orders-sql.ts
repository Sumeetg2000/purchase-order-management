import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestDatabase, type TestDatabase } from './db.js';
import { trackDatabase } from './setup.js';

// Raw-SQL helpers for the order tables (migration 0013): the integrity, trigger and schema
// tests act as po_app or po_owner directly, below the service layer, as the attack suite
// requires (ADR-0003). Ids come from the caller like every app insert (migration 0012).

export const CHECK_VIOLATION = '23514';
export const UNIQUE_VIOLATION = '23505';
export const INSUFFICIENT_PRIVILEGE = '42501';
export const GENERATED_ALWAYS = '428C9';
export const ACTOR_CONTEXT_REQUIRED = 'PO001';
export const DERIVED_VALUE_READ_ONLY = 'PO005';
export const ORDER_LINES_LOCKED = 'PO006';
export const ORDER_WITHOUT_LINES = 'PO007';
export const ORDER_FIELD_IMMUTABLE = 'PO008';
export const ORDER_STATUS_TRANSITION_REFUSED = 'PO009';
export const ORDER_DELETE_REFUSED = 'PO010';
export const PO_NUMBER_UNASSIGNED = 'PO011';

export async function orderDatabase(): Promise<TestDatabase> {
  return trackDatabase(await createTestDatabase());
}

/** Sets a SYSTEM actor context bound to the open transaction. */
export async function systemContext(client: pg.Client): Promise<void> {
  await client.query(`SELECT set_config('app.actor_txid', txid_current()::text, true)`);
  await client.query(`SELECT set_config('app.actor_type', 'SYSTEM', true)`);
}

/**
 * Runs `work` in one transaction with a SYSTEM actor context (unless `context: false`),
 * committing at the end, so deferred constraint triggers fire at the COMMIT.
 */
export async function inTransaction<T>(
  client: pg.Client,
  work: (q: pg.Client) => Promise<T>,
  { context = true }: { context?: boolean } = {},
): Promise<T> {
  await client.query('BEGIN');
  try {
    if (context) await systemContext(client);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** The SQLSTATE `run` fails with, or undefined if it succeeds. */
export async function sqlstate(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

export interface OrderFixture {
  db: TestDatabase;
  app: pg.Client;
  owner: pg.Client;
  superuser: pg.Client;
  buyerId: string;
  vendorId: string;
}

/** A database with one Buyer and one active vendor, and a client per role. */
export async function orderFixture(): Promise<OrderFixture> {
  const db = await orderDatabase();
  const app = await db.client('po_app');
  const owner = await db.client('po_owner');
  const superuser = await db.client('postgres');
  const buyerId = randomUUID();
  const vendorId = randomUUID();
  await inTransaction(app, async (q) => {
    await q.query(
      `INSERT INTO users (id, name, email, roles, status)
       VALUES ($1, 'Asha Buyer', $2, '{BUYER}', 'ACTIVE')`,
      [buyerId, `buyer-${buyerId}@example.test`],
    );
    await q.query(
      `INSERT INTO vendors (id, name, contact_name, contact_email, payment_term_type, net_days)
       VALUES ($1, $2, 'Ravi Shah', 'ravi@acme.example', 'NET', 30)`,
      [vendorId, `Acme ${vendorId}`],
    );
  });
  return { db, app, owner, superuser, buyerId, vendorId };
}

export interface LineInput {
  description?: string;
  quantity: number;
  unitPrice: string;
}

/** Inserts lines for an order in one statement, positions from `firstPosition`. */
export async function insertLines(
  q: pg.Client,
  orderId: string,
  lines: readonly LineInput[],
  firstPosition = 0,
): Promise<string[]> {
  const ids = lines.map(() => randomUUID());
  await q.query(
    `INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price)
     SELECT id, $1, $2 + ord - 1, description, quantity, unit_price
     FROM unnest($3::uuid[], $4::text[], $5::int[], $6::numeric[])
       WITH ORDINALITY AS l(id, description, quantity, unit_price, ord)`,
    [
      orderId,
      firstPosition,
      ids,
      lines.map((l, i) => l.description ?? `Line ${String(firstPosition + i + 1)}`),
      lines.map((l) => l.quantity),
      lines.map((l) => l.unitPrice),
    ],
  );
  return ids;
}

/** Takes the next PO number of the FY of `now()` for an order, as the create does. */
export async function assignPoNumber(q: pg.Client, orderId: string): Promise<string> {
  const { rows } = await q.query<{ po_number: string }>(
    `WITH n AS (
       INSERT INTO po_number_counters (fy, last_value)
       VALUES (po_financial_year(now()), 1)
       ON CONFLICT (fy) DO UPDATE SET last_value = po_number_counters.last_value + 1
       RETURNING fy, last_value
     )
     UPDATE purchase_orders o
        SET po_number = format('PO-%s-%s', n.fy, lpad(n.last_value::text, 6, '0'))
       FROM n WHERE o.id = $1
     RETURNING o.po_number`,
    [orderId],
  );
  const poNumber = rows[0]?.po_number;
  if (poNumber === undefined) throw new Error(`order ${orderId} not found`);
  return poNumber;
}

/** Inserts a complete draft (order, lines, PO number) inside the caller's transaction. */
export async function insertDraft(
  q: pg.Client,
  { buyerId, vendorId }: { buyerId: string; vendorId: string },
  lines: readonly LineInput[],
): Promise<{ orderId: string; lineIds: string[]; poNumber: string }> {
  const orderId = randomUUID();
  await q.query(`INSERT INTO purchase_orders (id, owner_id, vendor_id) VALUES ($1, $2, $3)`, [
    orderId,
    buyerId,
    vendorId,
  ]);
  const lineIds = await insertLines(q, orderId, lines);
  const poNumber = await assignPoNumber(q, orderId);
  return { orderId, lineIds, poNumber };
}

/** Creates a committed draft as po_app. */
export async function createDraft(
  f: OrderFixture,
  lines: readonly LineInput[],
): Promise<{ orderId: string; lineIds: string[]; poNumber: string }> {
  return inTransaction(f.app, (q) => insertDraft(q, f, lines));
}

export interface OrderRow {
  total: string;
  open_line_count: number;
  status: string;
  po_number: string | null;
  version: number;
}

export async function readOrder(q: pg.Client, orderId: string): Promise<OrderRow | undefined> {
  const { rows } = await q.query<OrderRow>(
    `SELECT total::text AS total, open_line_count, status, po_number, version
       FROM purchase_orders WHERE id = $1`,
    [orderId],
  );
  return rows[0];
}

/** Rows the committed reconciliation query returns, read as po_app. */
export async function reconciliationRows(
  q: pg.Client,
): Promise<{ invariant: string; entity_id: string; detail: string }[]> {
  const { readReconciliationSql } = await import('../../src/db/reconciliation.js');
  const { rows } = await q.query<{ invariant: string; entity_id: string; detail: string }>(
    readReconciliationSql(),
  );
  return rows;
}

/**
 * Runs `sql` as the superuser with the user triggers of the order tables off, to plant a
 * state no other path can reach (a non-draft order, a broken invariant).
 */
export async function plant(f: OrderFixture, sql: string, params: unknown[] = []): Promise<void> {
  await f.superuser.query('BEGIN');
  try {
    await f.superuser.query(`SET LOCAL session_replication_role = replica`);
    await f.superuser.query(sql, params);
    await f.superuser.query('COMMIT');
  } catch (error) {
    await f.superuser.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
