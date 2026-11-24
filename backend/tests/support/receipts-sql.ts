import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  createDraft,
  inTransaction,
  plant,
  plantSubmitted,
  type LineInput,
  type OrderFixture,
} from './orders-sql.js';

// Raw-SQL helpers for receipts (migration 0016, specs/007-goods-receipt/data-model.md): the
// schema, trigger, attack and property tests insert receipts as po_app or po_owner
// directly, below the service, as the attack suite requires (ADR-0003).

export const ORDER_CANCEL_REFUSED = 'PO019';
export const ORDER_NOT_RECEIVABLE = 'PO020';
export const RECEIPT_NOT_BY_OWNER = 'PO021';
export const RECEIPT_EXCEEDS_ORDERED = 'PO022';
export const RECEIPT_IMMUTABLE = 'PO023';
export const RECEIPT_BEFORE_APPROVAL = 'PO024';
export const RECEIPT_DATE_TOO_LATE = 'PO025';
export const FOREIGN_KEY_VIOLATION = '23503';

export type SqlActor =
  | { type: 'SYSTEM' }
  | { type: 'OPERATOR' }
  | { type: 'USER'; userId: string; role: 'BUYER' | 'APPROVER' };

/** Sets the open transaction's actor context as withTransaction would. */
export async function actAs(q: pg.Client, actor: SqlActor): Promise<void> {
  await q.query(
    `SELECT set_config('app.actor_txid', txid_current()::text, true),
            set_config('app.actor_type', $1, true),
            set_config('app.actor_user_id', $2, true),
            set_config('app.actor_name', $3, true),
            set_config('app.actor_email', $4, true),
            set_config('app.acting_role', $5, true),
            set_config('app.os_user', $6, true),
            set_config('app.os_host', $6, true)`,
    [
      actor.type,
      actor.type === 'USER' ? actor.userId : '',
      actor.type === 'USER' ? 'Someone' : '',
      actor.type === 'USER' ? 'someone@example.test' : '',
      actor.type === 'USER' ? actor.role : '',
      actor.type === 'OPERATOR' ? 'tester' : '',
    ],
  );
}

/** Runs `work` in one committed transaction as `actor`; deferred checks fire at COMMIT. */
export async function asActor<T>(
  q: pg.Client,
  actor: SqlActor,
  work: (q: pg.Client) => Promise<T>,
): Promise<T> {
  await q.query('BEGIN');
  try {
    await actAs(q, actor);
    const result = await work(q);
    await q.query('COMMIT');
    return result;
  } catch (error) {
    await q.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** The fixture's Buyer as a USER actor acting as BUYER. */
export function buyer(f: OrderFixture): SqlActor {
  return { type: 'USER', userId: f.buyerId, role: 'BUYER' };
}

export interface ReceiptRow {
  lineId: string;
  quantity: number;
  /** `YYYY-MM-DD`; default: the database's India date. */
  receivedAt?: string;
  /** Default: the order's owner. */
  recordedBy?: string;
  note?: string | null;
}

/**
 * One receipts INSERT for one order, as the service sends it (one statement, whatever the
 * row count), inside the caller's transaction.
 */
export async function insertReceipts(
  q: pg.Client,
  orderId: string,
  rows: readonly ReceiptRow[],
): Promise<void> {
  await q.query(
    `INSERT INTO receipts (order_id, line_id, quantity, received_at, recorded_by, note)
     SELECT $1, r.line_id, r.quantity,
            coalesce(r.received_at, (now() AT TIME ZONE 'Asia/Kolkata')::date),
            coalesce(r.recorded_by, (SELECT owner_id FROM purchase_orders WHERE id = $1)),
            r.note
       FROM unnest($2::uuid[], $3::int[], $4::date[], $5::uuid[], $6::text[])
         AS r(line_id, quantity, received_at, recorded_by, note)`,
    [
      orderId,
      rows.map((r) => r.lineId),
      rows.map((r) => r.quantity),
      rows.map((r) => r.receivedAt ?? null),
      rows.map((r) => r.recordedBy ?? null),
      rows.map((r) => r.note ?? null),
    ],
  );
}

/** Records receipts as the fixture's Buyer in one committed transaction. */
export async function receive(
  f: OrderFixture,
  orderId: string,
  rows: readonly ReceiptRow[],
): Promise<void> {
  await asActor(f.app, buyer(f), (q) => insertReceipts(q, orderId, rows));
}

/** A committed draft planted as approved (by a planted Approver), with its line ids. */
export async function approvedOrder(
  f: OrderFixture,
  lines: readonly LineInput[],
): Promise<{ orderId: string; lineIds: string[]; approverId: string }> {
  const { orderId, lineIds } = await createDraft(f, lines);
  const { approverId } = await plantSubmitted(f, orderId, 'APPROVED');
  return { orderId, lineIds, approverId };
}

/**
 * Moves an approved order's approval (approved_at and its round's close) `days` days into
 * the past, below the guards, so a receipt date can fall before it.
 */
export async function approvedDaysAgo(
  f: OrderFixture,
  orderId: string,
  days: number,
): Promise<void> {
  await plant(
    f,
    `WITH o AS (
       UPDATE purchase_orders SET approved_at = approved_at - make_interval(days => $2),
              submitted_at = submitted_at - make_interval(days => $2)
        WHERE id = $1 RETURNING id, current_round, approved_at, submitted_at
     )
     UPDATE approval_rounds r SET closed_at = o.approved_at, submitted_at = o.submitted_at
       FROM o WHERE r.order_id = o.id AND r.round = o.current_round`,
    [orderId, days],
  );
}

/** The India date of the order's approval, `offset` days on, as `YYYY-MM-DD`. */
export async function approvalDate(q: pg.Client, orderId: string, offset = 0): Promise<string> {
  const { rows } = await q.query<{ d: string }>(
    `SELECT ((approved_at AT TIME ZONE 'Asia/Kolkata')::date + $2::int)::text AS d
       FROM purchase_orders WHERE id = $1`,
    [orderId, offset],
  );
  return rows[0]?.d ?? '';
}

/** The database's India date, `offset` days on, as `YYYY-MM-DD`. */
export async function databaseDate(q: pg.Client, offset = 0): Promise<string> {
  const { rows } = await q.query<{ d: string }>(
    `SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`,
    [offset],
  );
  return rows[0]?.d ?? '';
}

export interface LineState {
  id: string;
  position: number;
  quantity: number;
  received_quantity: number;
}

export async function readLines(q: pg.Client, orderId: string): Promise<LineState[]> {
  const { rows } = await q.query<LineState>(
    `SELECT id, position, quantity, received_quantity FROM order_lines
      WHERE order_id = $1 ORDER BY position`,
    [orderId],
  );
  return rows;
}

export async function receiptCount(q: pg.Client, orderId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM receipts WHERE order_id = $1`,
    [orderId],
  );
  return rows[0]?.n ?? 0;
}

/** A second active Buyer, for receipts recorded by someone other than the owner. */
export async function anotherBuyer(f: OrderFixture): Promise<string> {
  const id = randomUUID();
  await inTransaction(f.app, (q) =>
    q.query(
      `INSERT INTO users (id, name, email, roles, status)
       VALUES ($1, 'Other Buyer', $2, '{BUYER}', 'ACTIVE')`,
      [id, `buyer-${id}@example.test`],
    ),
  );
  return id;
}
