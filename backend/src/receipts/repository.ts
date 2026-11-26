import { RECEIPT_TIME_ZONE, type OrderStatus } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PageArgs, RowsAndTotal } from '../lib/pagination.js';

// Goods receipts (specs/007-goods-receipt/research.md R1, R5–R7): the only code that
// queries goods_receipts and goods_receipt_lines. A receipt and its lines are written in one
// statement; the triggers keep the lines' received quantities and the order's open-line
// count, and refuse anything the service should have refused first.

type Db = AuditedTransaction | AppPrismaClient;

/** The order as a receipt reads it, under its lock. */
export interface ReceiptOrder {
  id: string;
  ownerId: string;
  status: OrderStatus;
  poNumber: string | null;
  openLineCount: number;
  /** The approval date in India time (`YYYY-MM-DD`); null if never approved. */
  approvedOn: string | null;
}

/** Locks the order FOR UPDATE: the receipt's first lock after its key (ADR-0006). */
export async function lockReceiptOrder(
  tx: AuditedTransaction,
  id: string,
): Promise<ReceiptOrder | null> {
  const [row] = await tx.$queryRaw<ReceiptOrder[]>`
    SELECT id::text, owner_id::text AS "ownerId", status, po_number AS "poNumber",
           open_line_count::int AS "openLineCount",
           ((approved_at AT TIME ZONE ${RECEIPT_TIME_ZONE})::date)::text AS "approvedOn"
      FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
  return row ?? null;
}

/** A line a receipt names, as read under its lock. */
export interface ReceiptLineState {
  id: string;
  position: number;
  quantity: number;
  receivedQuantity: number;
}

/**
 * Locks the named lines of the order in id order and reads them (one statement); a named
 * line that isn't on this order is simply not returned.
 */
export async function lockReceiptLines(
  tx: AuditedTransaction,
  orderId: string,
  lineIds: readonly string[],
): Promise<ReceiptLineState[]> {
  return tx.$queryRaw<ReceiptLineState[]>`
    SELECT id::text, position, quantity, received_quantity AS "receivedQuantity"
      FROM order_lines
     WHERE order_id = ${orderId}::uuid AND id = ANY(${[...lineIds]}::uuid[])
     ORDER BY id FOR UPDATE`;
}

export interface NewReceipt {
  orderId: string;
  receivedOn: string;
  recordedBy: string;
  note: string | null;
  lines: readonly { lineId: string; quantity: number }[];
}

/**
 * Inserts the receipt and all its lines in one statement (a CTE): a receipt's lines arrive
 * in the INSERT that creates it (D16). Returns its id and the database's recorded time.
 */
export async function insertReceipt(
  tx: AuditedTransaction,
  receipt: NewReceipt,
): Promise<{ id: string; recordedAt: Date }> {
  const [row] = await tx.$queryRaw<{ id: string; recordedAt: Date }[]>`
    WITH r AS (
      INSERT INTO goods_receipts (order_id, received_on, recorded_by, note)
      VALUES (${receipt.orderId}::uuid, ${receipt.receivedOn}::date, ${receipt.recordedBy}::uuid,
              ${receipt.note})
      RETURNING id, order_id, recorded_at
    ), l AS (
      INSERT INTO goods_receipt_lines (receipt_id, order_id, line_id, quantity)
      SELECT r.id, r.order_id, x.line_id, x.quantity
        FROM r, unnest(${receipt.lines.map((l) => l.lineId)}::uuid[],
                       ${receipt.lines.map((l) => l.quantity)}::int[]) AS x(line_id, quantity)
    )
    SELECT id::text, recorded_at AS "recordedAt" FROM r`;
  if (!row) throw new Error('the receipt insert returned no row');
  return row;
}

/** A receipt's own fields, with its recorder's current name. */
export interface ReceiptHeadRow {
  id: string;
  receivedOn: string;
  recordedAt: Date;
  recordedById: string;
  recordedByName: string;
  note: string | null;
}

export interface ReceiptSummaryRow extends ReceiptHeadRow {
  lineCount: number;
}

/**
 * A page of the order's receipts, newest recorded first, with their line counts, and how
 * many it has: the page and the count read goods_receipts_order_recorded_idx; each line
 * count is an index-only count on the lines' primary key, after the page is cut.
 */
export function receiptPageSql(
  orderId: string,
  { offset, limit }: PageArgs,
): { statement: Prisma.Sql; page: Prisma.Sql; count: Prisma.Sql } {
  const page = Prisma.sql`
    SELECT r.id, r.received_on, r.recorded_at, r.recorded_by, r.note,
           (SELECT count(*) FROM goods_receipt_lines gl WHERE gl.receipt_id = r.id) AS line_count
      FROM goods_receipts r
     WHERE r.order_id = ${orderId}::uuid
     ORDER BY r.recorded_at DESC, r.id DESC
     LIMIT ${limit} OFFSET ${offset}`;
  const count = Prisma.sql`SELECT count(*) FROM goods_receipts WHERE order_id = ${orderId}::uuid`;
  const statement = Prisma.sql`
    SELECT (${count})::int AS total,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', p.id::text,
                      'receivedOn', p.received_on::text,
                      'recordedAt', p.recorded_at,
                      'recordedById', u.id::text,
                      'recordedByName', u.name,
                      'note', p.note,
                      'lineCount', p.line_count)
                    ORDER BY p.recorded_at DESC, p.id DESC)
               FROM (${page}) p JOIN users u ON u.id = p.recorded_by), '[]'::json) AS rows`;
  return { statement, page, count };
}

/** One statement, one snapshot: the page and its total always agree. */
export async function listReceipts(
  db: Db,
  orderId: string,
  page: PageArgs,
): Promise<RowsAndTotal<ReceiptSummaryRow>> {
  const [result] = await db.$queryRaw<
    { total: number; rows: (Omit<ReceiptSummaryRow, 'recordedAt'> & { recordedAt: string })[] }[]
  >(receiptPageSql(orderId, page).statement);
  return {
    rows: (result?.rows ?? []).map((row) => ({ ...row, recordedAt: new Date(row.recordedAt) })),
    total: result?.total ?? 0,
  };
}

export interface ReceiptDetailRow extends ReceiptHeadRow {
  lines: { lineId: string; position: number; description: string; quantity: number }[];
}

/** One receipt's lines in position order, by the lines' primary key, joined to order_lines. */
export function receiptLinesSql(receiptId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT ol.id, ol.position, ol.description, gl.quantity
      FROM goods_receipt_lines gl
      JOIN order_lines ol ON ol.id = gl.line_id
     WHERE gl.receipt_id = ${receiptId}::uuid
     ORDER BY ol.position`;
}

/** The receipt if it is on this order, with its lines; null otherwise. One statement. */
export async function selectReceipt(
  db: Db,
  orderId: string,
  receiptId: string,
): Promise<ReceiptDetailRow | null> {
  const [row] = await db.$queryRaw<(Omit<ReceiptDetailRow, 'recordedAt'> & { recordedAt: Date })[]>`
    SELECT r.id::text, r.received_on::text AS "receivedOn", r.recorded_at AS "recordedAt",
           u.id::text AS "recordedById", u.name AS "recordedByName", r.note,
           (SELECT coalesce(json_agg(json_build_object(
                      'lineId', x.id::text,
                      'position', x.position,
                      'description', x.description,
                      'quantity', x.quantity) ORDER BY x.position), '[]'::json)
              FROM (${receiptLinesSql(receiptId)}) x) AS lines
      FROM goods_receipts r
      JOIN users u ON u.id = r.recorded_by
     WHERE r.id = ${receiptId}::uuid AND r.order_id = ${orderId}::uuid`;
  return row ?? null;
}
