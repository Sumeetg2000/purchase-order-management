import {
  ORDER_STATUSES,
  PO_NUMBER_TIME_ZONE,
  type Money,
  type OrderListItem,
  type OrderStatus,
  type VendorStatus,
} from '@po/contracts';
import { Prisma } from '../generated/prisma/client.js';
import type { PageArgs } from '../lib/pagination.js';
import type { AppPrismaClient } from '../db/client.js';
import type { AuditedTransaction } from '../db/transaction.js';

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

/** Inserts the order with no PO number: the create numbers it last (research R2). */
export async function insertOrder(
  tx: AuditedTransaction,
  order: { id: string; ownerId: string; vendorId: string },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO purchase_orders (id, owner_id, vendor_id)
    VALUES (${order.id}::uuid, ${order.ownerId}::uuid, ${order.vendorId}::uuid)`;
}

/** A line to insert: its id (from the caller, so an audit entry can name it) and position. */
export interface NewLine {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unitPrice: Money;
}

/** A stored line's new state, by id. */
export type ChangedLine = NewLine;

/**
 * Inserts the lines in one statement, so the order's total is recomputed once whatever the
 * line count. Prices go as text.
 */
export async function insertOrderLines(
  tx: AuditedTransaction,
  orderId: string,
  lines: readonly NewLine[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price)
    SELECT l.id, ${orderId}::uuid, l.position, l.description, l.quantity, l.unit_price
      FROM unnest(${lines.map((l) => l.id)}::uuid[], ${lines.map((l) => l.position)}::int[],
                  ${lines.map((l) => l.description)}::text[], ${lines.map((l) => l.quantity)}::int[],
                  ${lines.map((l) => l.unitPrice)}::numeric[])
           AS l(id, position, description, quantity, unit_price)`;
}

/** Updates the changed lines of one order in one statement (research R6). */
export async function updateOrderLines(
  tx: AuditedTransaction,
  orderId: string,
  lines: readonly ChangedLine[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.$executeRaw`
    UPDATE order_lines o
       SET position = l.position, description = l.description, quantity = l.quantity,
           unit_price = l.unit_price
      FROM unnest(${lines.map((l) => l.id)}::uuid[], ${lines.map((l) => l.position)}::int[],
                  ${lines.map((l) => l.description)}::text[], ${lines.map((l) => l.quantity)}::int[],
                  ${lines.map((l) => l.unitPrice)}::numeric[])
           AS l(id, position, description, quantity, unit_price)
     WHERE o.id = l.id AND o.order_id = ${orderId}::uuid`;
}

/** Deletes lines of one order in one statement. */
export async function deleteOrderLines(
  tx: AuditedTransaction,
  orderId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.$executeRaw`
    DELETE FROM order_lines WHERE order_id = ${orderId}::uuid AND id = ANY(${ids}::uuid[])`;
}

/** What an edit checks under the order's lock. */
export interface LockedOrder {
  id: string;
  ownerId: string;
  status: OrderStatus;
  version: number;
}

/** Locks the order FOR UPDATE (ADR-0006: the order first, then its lines, then the vendor). */
export async function lockOrder(tx: AuditedTransaction, id: string): Promise<LockedOrder | null> {
  const [row] = await tx.$queryRaw<LockedOrder[]>`
    SELECT id::text, owner_id::text AS "ownerId", status, version
      FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
  return row ?? null;
}

/** Locks the order's lines in id order (a stable order for every locker). */
export async function lockOrderLines(tx: AuditedTransaction, orderId: string): Promise<void> {
  await tx.$executeRaw`
    SELECT 1 FROM order_lines WHERE order_id = ${orderId}::uuid ORDER BY id FOR UPDATE`;
}

/** Deletes the order, its lines with it (ON DELETE CASCADE); the caller holds its lock. */
export async function deleteOrderRow(tx: AuditedTransaction, id: string): Promise<void> {
  await tx.$executeRaw`DELETE FROM purchase_orders WHERE id = ${id}::uuid`;
}

/** Moves the order to its new vendor and next version; the caller checked the version. */
export async function bumpOrder(
  tx: AuditedTransaction,
  id: string,
  vendorId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE purchase_orders SET vendor_id = ${vendorId}::uuid, version = version + 1
     WHERE id = ${id}::uuid`;
}

/**
 * The order with its owner's and vendor's current names and its lines, or null. One
 * statement, so one snapshot: the version (the ETag), the lines and the total always
 * belong to the same commit. Read in two statements, an edit committing between them
 * could pair a new version with old lines, and an edit sent with that ETag would replace
 * lines its user never saw. Amounts are text inside the JSON as well.
 */
export async function selectOrder(db: Db, id: string): Promise<OrderRow | null> {
  const [row] = await db.$queryRaw<OrderRow[]>`
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

/** Who the list is for (ADR-0004, research R11): the orders their roles let them read. */
export type OrderListScope =
  | { kind: 'all' }
  | { kind: 'own'; userId: string }
  | { kind: 'nonDraft' }
  | { kind: 'ownOrNonDraft'; userId: string };

export interface OrderListFilter {
  status?: OrderStatus | undefined;
  vendorId?: string | undefined;
  /** A PO-number prefix, upper-cased by the contract. */
  poNumber?: string | undefined;
  /** Inclusive calendar dates (YYYY-MM-DD) in PO_NUMBER_TIME_ZONE. */
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
}

const NON_DRAFT_STATUSES = ORDER_STATUSES.filter((status) => status !== 'DRAFT');

/** One part of a scope that a single index serves: an owner, a status, or both. */
interface Branch {
  owner?: { userId: string; mine: boolean };
  status?: OrderStatus;
}

/**
 * The scope as branches whose union is what the caller may read, each one walkable on its
 * own index in the list's order (research R7): a Buyer's own orders on the owner indexes,
 * an Approver's non-drafts one status at a time on the status index, so a union of
 * branches is a merge of ordered index scans that stops at the page. A status filter keeps
 * the branches it can match.
 */
function branchesOf(scope: OrderListScope, status: OrderStatus | undefined): Branch[] {
  const nonDraft = (owner?: Branch['owner']) =>
    NON_DRAFT_STATUSES.map((s): Branch => (owner ? { status: s, owner } : { status: s }));
  const all: Branch[] =
    scope.kind === 'all'
      ? [{}]
      : scope.kind === 'own'
        ? [{ owner: { userId: scope.userId, mine: true } }]
        : scope.kind === 'nonDraft'
          ? nonDraft()
          : [
              { owner: { userId: scope.userId, mine: true } },
              // Not the caller's own: those are in the first branch already.
              ...nonDraft({ userId: scope.userId, mine: false }),
            ];
  if (status === undefined) return all;
  return all
    .filter((b) => b.status === undefined || b.status === status)
    .map((b) => ({ ...b, status }));
}

/** A status as an SQL literal: from the contract's own list, so the planner sees it. */
function statusLiteral(status: OrderStatus): Prisma.Sql {
  if (!ORDER_STATUSES.includes(status)) throw new TypeError(`unknown order status ${status}`);
  return Prisma.raw(`'${status}'`);
}

/** The highest code point: every PO number with prefix p sorts below p || chr(MAX_CHAR). */
const MAX_CHAR = 1_114_111;

function filterConditions(filter: OrderListFilter): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filter.vendorId !== undefined)
    conditions.push(Prisma.sql`vendor_id = ${filter.vendorId}::uuid`);
  if (filter.poNumber !== undefined) {
    // A range on the "C"-collated column, so the index serves it under a generic plan too.
    conditions.push(Prisma.sql`po_number >= ${filter.poNumber}
      AND po_number < ${filter.poNumber} || chr(${MAX_CHAR}::int)`);
  }
  if (filter.createdFrom !== undefined) {
    conditions.push(
      Prisma.sql`created_at >= (${filter.createdFrom}::date::timestamp AT TIME ZONE ${PO_NUMBER_TIME_ZONE})`,
    );
  }
  if (filter.createdTo !== undefined) {
    conditions.push(
      Prisma.sql`created_at < ((${filter.createdTo}::date + 1)::timestamp AT TIME ZONE ${PO_NUMBER_TIME_ZONE})`,
    );
  }
  return conditions;
}

function branchSql(branch: Branch, filters: Prisma.Sql[], columns: Prisma.Sql): Prisma.Sql {
  const conditions = [...filters];
  if (branch.owner) {
    conditions.push(
      branch.owner.mine
        ? Prisma.sql`owner_id = ${branch.owner.userId}::uuid`
        : Prisma.sql`owner_id <> ${branch.owner.userId}::uuid`,
    );
  }
  if (branch.status) conditions.push(Prisma.sql`status = ${statusLiteral(branch.status)}`);
  const where =
    conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  return Prisma.sql`SELECT ${columns} FROM purchase_orders ${where}`;
}

/**
 * A page bound as an SQL literal, not a parameter: the contract has checked it (a page
 * size of at most 50), and a generic plan that can't see the LIMIT may plan for the whole
 * table.
 */
function pageNumber(value: number): Prisma.Sql {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`bad page bound ${String(value)}`);
  return Prisma.raw(String(value));
}

export interface OrderListSql {
  /** What the API runs: the page and the total in one statement, one snapshot. */
  statement: Prisma.Sql;
  /** Its parts, each planned on its own: for the plan tests and committed plans. */
  page: Prisma.Sql;
  count: Prisma.Sql;
}

/**
 * The order list's SQL (research R7): the scope's branches with the filters, sorted newest
 * first (created time, then id), or by PO number, newest first, with a PO-number prefix
 * (owner decision, 2026-11-12), each sort served by an index.
 */
export function orderListSql(
  scope: OrderListScope,
  filter: OrderListFilter,
  { offset, limit }: PageArgs,
): OrderListSql {
  const filters = filterConditions(filter);
  const branches = branchesOf(scope, filter.status);
  const byPoNumber = filter.poNumber !== undefined;
  const order = (alias: string) =>
    byPoNumber
      ? Prisma.raw(`${alias}.po_number DESC`)
      : Prisma.raw(`${alias}.created_at DESC, ${alias}.id DESC`);
  /**
   * The branches' union. For a page of a scope with several branches, each branch is cut
   * to the page's end in its own index order first: PostgreSQL appends a union and sorts
   * it rather than merging ordered scans, so without the cut it would sort every order of
   * the caller's. With it, nothing past offset + limit is read from any branch.
   */
  const union = (columns: Prisma.Sql, cut?: number) =>
    branches.length === 0
      ? Prisma.sql`SELECT ${columns} FROM purchase_orders WHERE false`
      : branches.length === 1 || cut === undefined
        ? Prisma.join(
            branches.map((b) => branchSql(b, filters, columns)),
            ' UNION ALL ',
          )
        : Prisma.join(
            branches.map(
              (b) =>
                Prisma.sql`(${branchSql(b, filters, columns)} ORDER BY ${order('purchase_orders')}
                  LIMIT ${pageNumber(cut)})`,
            ),
            ' UNION ALL ',
          );
  // A deferred join: the page picks only its sort keys, which every list index holds, so
  // it walks the index alone (an index-only scan) to the page and no further; only the
  // page's own rows are then read from the table.
  const keys = byPoNumber ? Prisma.sql`po_number` : Prisma.sql`created_at, id`;
  const join = byPoNumber ? Prisma.sql`o.po_number = k.po_number` : Prisma.sql`o.id = k.id`;
  const page = Prisma.sql`SELECT o.id, o.po_number, o.status, o.owner_id, o.vendor_id, o.total,
           o.created_at
      FROM (SELECT k.* FROM (${union(keys, offset + limit)}) k
             ORDER BY ${order('k')} LIMIT ${pageNumber(limit)} OFFSET ${pageNumber(offset)}) k
      JOIN purchase_orders o ON ${join}`;
  const count = Prisma.sql`SELECT count(*) FROM (${union(Prisma.sql`1 AS one`)}) c`;
  const statement = Prisma.sql`
    SELECT (${count})::int AS total,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', p.id::text,
                      'poNumber', p.po_number,
                      'status', p.status,
                      'vendor', json_build_object('id', p.vendor_id::text, 'name', v.name),
                      'owner', json_build_object('id', p.owner_id::text, 'name', u.name),
                      'total', p.total::text,
                      'lineCount', (SELECT count(*) FROM order_lines l WHERE l.order_id = p.id),
                      'createdAt', to_char(p.created_at AT TIME ZONE 'UTC',
                                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                    ORDER BY ${order('p')})
               FROM (${page}) p
               JOIN users u ON u.id = p.owner_id
               JOIN vendors v ON v.id = p.vendor_id), '[]'::json) AS items`;
  return { statement, page, count };
}

/** One page of the list and its total, from one statement, so they always agree. */
export async function listOrders(
  db: Db,
  scope: OrderListScope,
  filter: OrderListFilter,
  page: PageArgs,
): Promise<{ items: OrderListItem[]; total: number }> {
  const [row] = await db.$queryRaw<{ total: number; items: OrderListItem[] }[]>(
    orderListSql(scope, filter, page).statement,
  );
  return { items: row?.items ?? [], total: row?.total ?? 0 };
}

/** Who owns an order and its status, for reads that need only its visibility. */
export async function selectOrderAccess(
  db: Db,
  id: string,
): Promise<{ ownerId: string; status: OrderStatus } | null> {
  const [row] = await db.$queryRaw<{ ownerId: string; status: OrderStatus }[]>`
    SELECT owner_id::text AS "ownerId", status FROM purchase_orders WHERE id = ${id}::uuid`;
  return row ?? null;
}
