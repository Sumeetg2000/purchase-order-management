import type { Money, OrderStatus, VendorStatus } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';

// Purchase orders and their lines (data-model.md). Money columns are read as text, so no
// decimal object or JavaScript number ever holds an amount (ADR-0010); the service turns the
// text into Money with money.ts. The derived columns (total, open_line_count, line_total)
// are never written here: the database keeps them (research R3).

type Db = AuditedTransaction | AppPrismaClient;

export interface OrderHeaderRow {
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
}

export interface OrderLineRow {
  id: string;
  position: number;
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

/** The order with its owner's and vendor's current names, or null. */
export async function selectOrderHeader(db: Db, id: string): Promise<OrderHeaderRow | null> {
  const [row] = await db.$queryRaw<OrderHeaderRow[]>`
    SELECT o.id::text, o.po_number AS "poNumber", o.status, o.owner_id::text AS "ownerId",
           u.name AS "ownerName", o.vendor_id::text AS "vendorId", v.name AS "vendorName",
           v.status AS "vendorStatus", o.total::text AS total, o.version,
           o.created_at AS "createdAt", o.updated_at AS "updatedAt"
      FROM purchase_orders o
      JOIN users u ON u.id = o.owner_id
      JOIN vendors v ON v.id = o.vendor_id
     WHERE o.id = ${id}::uuid`;
  return row ?? null;
}

/** The order's lines in display order. */
export async function selectOrderLines(db: Db, orderId: string): Promise<OrderLineRow[]> {
  return db.$queryRaw<OrderLineRow[]>`
    SELECT id::text, position, description, quantity, unit_price::text AS "unitPrice",
           line_total::text AS "lineTotal"
      FROM order_lines
     WHERE order_id = ${orderId}::uuid
     ORDER BY position`;
}
