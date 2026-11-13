import type { Money, OrderStatus, VendorStatus } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';

// Purchase orders and their lines (data-model.md). Money columns are read as text, so no
// decimal object or JavaScript number ever holds an amount (ADR-0010); the service turns the
// text into Money with money.ts. The derived columns (total, open_line_count, line_total)
// are never written here: the database keeps them (research R3).

type Db = AuditedTransaction | AppPrismaClient;

/** One order as read in one statement: header, owner and vendor names, and its lines. */
export interface OrderRow {
  id: string;
  poNumber: string | null;
  status: OrderStatus;
  ownerId: string;
  ownerName: string;
  vendorId: string;
  vendorName: string;
  vendorStatus: VendorStatus;
  /** numeric(22,4) as text, e.g. "0.3875". */
  total: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** In display order. */
  lines: OrderLineRow[];
}

export interface OrderLineRow {
  id: string;
  description: string;
  quantity: number;
  /** numeric as text. */
  unitPrice: string;
  lineTotal: string;
}

export interface NewLine {
  description: string;
  quantity: number;
  unitPrice: Money;
}

/** Inserts the order with no PO number: the create numbers it last (research R2). */
export async function insertOrder(
  tx: AuditedTransaction,
  order: { id: string; ownerId: string; vendorId: string },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO purchase_orders (id, owner_id, vendor_id)
    VALUES (${order.id}::uuid, ${order.ownerId}::uuid, ${order.vendorId}::uuid)`;
}

/**
 * Inserts the lines in one statement, positions in array order from `firstPosition`, so the
 * order's total is recomputed once whatever the line count. Prices go as text.
 */
export async function insertOrderLines(
  tx: AuditedTransaction,
  orderId: string,
  lines: readonly NewLine[],
  firstPosition = 0,
): Promise<void> {
  if (lines.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price)
    SELECT l.id, ${orderId}::uuid, ${firstPosition}::int + l.ord::int - 1, l.description,
           l.quantity, l.unit_price
      FROM unnest(${lines.map(() => uuidv7())}::uuid[], ${lines.map((l) => l.description)}::text[],
                  ${lines.map((l) => l.quantity)}::int[], ${lines.map((l) => l.unitPrice)}::numeric[])
           WITH ORDINALITY AS l(id, description, quantity, unit_price, ord)`;
}

/**
 * The order with its owner's and vendor's current names and its lines, or null. One
 * statement, so one snapshot: the version (the ETag), the lines and the total always
 * belong to the same commit. Read in two statements, an edit committing between them
 * could pair a new version with old lines, and an edit sent with that ETag would replace
 * lines its user never saw. Amounts are text inside the JSON as well.
 */
export async function selectOrder(db: Db, id: string): Promise<OrderRow | null> {
  const [row] = await db.$queryRaw<
    (Omit<OrderRow, 'createdAt' | 'updatedAt'> & {
      createdAt: Date;
      updatedAt: Date;
    })[]
  >`
    SELECT o.id::text, o.po_number AS "poNumber", o.status, o.owner_id::text AS "ownerId",
           u.name AS "ownerName", o.vendor_id::text AS "vendorId", v.name AS "vendorName",
           v.status AS "vendorStatus", o.total::text AS total, o.version,
           o.created_at AS "createdAt", o.updated_at AS "updatedAt",
           (SELECT coalesce(json_agg(json_build_object(
                      'id', l.id::text,
                      'description', l.description,
                      'quantity', l.quantity,
                      'unitPrice', l.unit_price::text,
                      'lineTotal', l.line_total::text) ORDER BY l.position), '[]'::json)
              FROM order_lines l WHERE l.order_id = o.id) AS lines
      FROM purchase_orders o
      JOIN users u ON u.id = o.owner_id
      JOIN vendors v ON v.id = o.vendor_id
     WHERE o.id = ${id}::uuid`;
  return row ?? null;
}
