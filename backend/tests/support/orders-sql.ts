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
        SET po_number = format('PO-%s-%s', n.fy,
                               lpad(n.last_value::text, greatest(6, length(n.last_value::text)), '0'))
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

export type SubmittedStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

/** A fixture's superuser client, or a harness's superuser `query` (rows only). */
export type PlantTarget =
  | { superuser: pg.Client }
  | { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> };

/**
 * Plants a consistent submitted state on a draft (slice 4, data-model.md), as the
 * superuser with triggers off: the next approval round under the current policy, with the
 * order's total and a snapshot of its vendor, one step per tier the total exceeds, and the
 * order's status and submission columns to match. PENDING_APPROVAL has every step open;
 * APPROVED has every step approved (or none: an auto-approval); REJECTED has its first step
 * rejected and the rest voided, so it needs a total above the lowest tier. Decisions are
 * made by `approverId`, or a planted Approver. The reconciliation's consistency check
 * accepts the result, unlike a bare status change.
 */
export async function plantSubmitted(
  target: PlantTarget,
  orderId: string,
  status: SubmittedStatus,
  { approverId }: { approverId?: string } = {},
): Promise<{ round: number; steps: number; approverId: string }> {
  const superuser = {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> =>
      'superuser' in target
        ? target.superuser.query(sql, params)
        : { rows: await target.query(sql, params) },
  };
  await superuser.query('BEGIN');
  try {
    await superuser.query(`SET LOCAL session_replication_role = replica`);
    const decider = approverId ?? randomUUID();
    if (approverId === undefined) {
      await superuser.query(
        `INSERT INTO users (id, name, email, roles, status)
         VALUES ($1, 'Planted Approver', $2, '{APPROVER}', 'ACTIVE')`,
        [decider, `approver-${decider}@example.test`],
      );
    }
    const { rows } = (await superuser.query(
      `WITH o AS (
         SELECT o.id, o.owner_id, o.total, coalesce(o.current_round, 0) + 1 AS round,
                jsonb_build_object(
                  'id', v.id, 'name', v.name, 'contactName', v.contact_name,
                  'contactEmail', v.contact_email, 'contactPhone', v.contact_phone,
                  'paymentTerms', jsonb_strip_nulls(jsonb_build_object(
                    'type', v.payment_term_type, 'netDays', v.net_days,
                    'advancePercent', v.advance_percent))) AS snapshot
           FROM purchase_orders o JOIN vendors v ON v.id = o.vendor_id
          WHERE o.id = $1 AND o.status = 'DRAFT'
       ), p AS (SELECT max(version) AS version FROM approval_policies),
       t AS (
         SELECT row_number() OVER (ORDER BY tier)::smallint AS step, tier, threshold
           FROM approval_policy_tiers, o, p
          WHERE policy_version = p.version AND threshold < o.total
       ), r AS (
         INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot,
                                      submitted_by, outcome, closed_at)
         SELECT o.id, o.round, p.version, o.total, o.snapshot, o.owner_id,
                CASE $2::text
                  WHEN 'PENDING_APPROVAL' THEN NULL
                  WHEN 'APPROVED' THEN CASE WHEN (SELECT count(*) FROM t) = 0
                                            THEN 'AUTO_APPROVED' ELSE 'APPROVED' END
                  ELSE 'REJECTED' END,
                CASE WHEN $2::text = 'PENDING_APPROVAL' THEN NULL ELSE now() END
           FROM o, p
         RETURNING order_id, round
       ), s AS (
         INSERT INTO approval_steps (order_id, round, step, tier, threshold, state, decided_by,
                                     decided_at, decided_version, reason, voided_at)
         SELECT r.order_id, r.round, t.step, t.tier, t.threshold, d.state,
                CASE WHEN d.state IN ('APPROVED', 'REJECTED') THEN $3::uuid END,
                CASE WHEN d.state IN ('APPROVED', 'REJECTED') THEN now() END,
                CASE WHEN d.state IN ('APPROVED', 'REJECTED') THEN 1 END,
                CASE WHEN d.state = 'REJECTED' THEN 'Planted rejection' END,
                CASE WHEN d.state = 'VOIDED' THEN now() END
           FROM r, t,
                LATERAL (SELECT CASE $2::text
                                  WHEN 'PENDING_APPROVAL' THEN 'OPEN'
                                  WHEN 'APPROVED' THEN 'APPROVED'
                                  ELSE CASE WHEN t.step = 1 THEN 'REJECTED' ELSE 'VOIDED' END
                                END AS state) d
         RETURNING 1
       )
       UPDATE purchase_orders po
          SET status = $2::text, current_round = r.round, submitted_at = now(),
              approved_at = CASE WHEN $2::text = 'APPROVED' THEN now() END,
              version = po.version + 1
         FROM r
        WHERE po.id = r.order_id
       RETURNING r.round::int AS round, (SELECT count(*) FROM s)::int AS steps`,
      [orderId, status, decider],
    )) as { rows: { round: number; steps: number }[] };
    const planted = rows[0];
    if (!planted) throw new Error(`order ${orderId} is not a draft`);
    if (status === 'REJECTED' && planted.steps === 0) {
      throw new Error('a rejected order needs a total above the lowest tier');
    }
    await superuser.query('COMMIT');
    return { ...planted, approverId: decider };
  } catch (error) {
    await superuser.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
