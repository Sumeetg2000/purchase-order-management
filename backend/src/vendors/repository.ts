import type { ExistingVendor, VendorStatus, VendorStatusFilter } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PaymentTermColumns, VendorRow } from './snapshot.js';

// Vendors (ADR-0005, data-model.md). The name rule lives only in SQL (research R2): the
// generated name_key column and vendor_name_key(), which every lookup by name calls, so
// nothing here normalises a name.

const COLUMNS = Prisma.sql`id::text, name, contact_name AS "contactName",
  contact_email AS "contactEmail", contact_phone AS "contactPhone",
  payment_term_type AS "paymentTermType", net_days AS "netDays",
  advance_percent AS "advancePercent", status, deactivated_at AS "deactivatedAt", version,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

/** What a create or an edit stores; the API has trimmed and lower-cased it already. */
export interface VendorFields extends PaymentTermColumns {
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
}

/**
 * Inserts the vendor, or returns null when its name key is taken (research R3). ON
 * CONFLICT waits for an in-flight insert of the same key and doesn't abort the
 * transaction, so the caller can read the winner next.
 */
export async function insertVendor(
  tx: AuditedTransaction,
  fields: VendorFields,
): Promise<VendorRow | null> {
  const [row] = await tx.$queryRaw<VendorRow[]>`
    INSERT INTO vendors (name, contact_name, contact_email, contact_phone,
                         payment_term_type, net_days, advance_percent)
    VALUES (${fields.name}, ${fields.contactName}, ${fields.contactEmail},
            ${fields.contactPhone}, ${fields.paymentTermType}, ${fields.netDays}::smallint,
            ${fields.advancePercent}::smallint)
    ON CONFLICT (name_key) DO NOTHING
    RETURNING ${COLUMNS}`;
  return row ?? null;
}

/**
 * The vendor whose name key equals that of `name`, or null. Inside the write's transaction,
 * or on its own after a rename lost the race for the key (research R3).
 */
export async function findVendorByNameKey(
  db: AuditedTransaction | AppPrismaClient,
  name: string,
): Promise<ExistingVendor | null> {
  const [row] = await db.$queryRaw<ExistingVendor[]>`
    SELECT id::text, name FROM vendors WHERE name_key = vendor_name_key(${name})`;
  return row ?? null;
}

/** Locks the vendor row for an edit or a status change (research R8), or null. */
export async function lockVendor(tx: AuditedTransaction, id: string): Promise<VendorRow | null> {
  const [row] = await tx.$queryRaw<VendorRow[]>`
    SELECT ${COLUMNS} FROM vendors WHERE id = ${id}::uuid FOR UPDATE`;
  return row ?? null;
}

/** Another vendor whose name key equals that of `name`, or null (an edit's clash check). */
export async function findClash(
  tx: AuditedTransaction,
  name: string,
  exceptId: string,
): Promise<ExistingVendor | null> {
  const [row] = await tx.$queryRaw<ExistingVendor[]>`
    SELECT id::text, name FROM vendors
     WHERE name_key = vendor_name_key(${name}) AND id <> ${exceptId}::uuid`;
  return row ?? null;
}

/** Replaces the editable fields and moves the version; the caller holds the row lock. */
export async function updateVendor(
  tx: AuditedTransaction,
  id: string,
  fields: VendorFields,
): Promise<VendorRow> {
  const [row] = await tx.$queryRaw<VendorRow[]>`
    UPDATE vendors
       SET name = ${fields.name}, contact_name = ${fields.contactName},
           contact_email = ${fields.contactEmail}, contact_phone = ${fields.contactPhone},
           payment_term_type = ${fields.paymentTermType},
           net_days = ${fields.netDays}::smallint,
           advance_percent = ${fields.advancePercent}::smallint,
           version = version + 1
     WHERE id = ${id}::uuid
    RETURNING ${COLUMNS}`;
  if (!row) throw new Error(`Vendor ${id} vanished while locked`);
  return row;
}

/**
 * Sets the status, with deactivated_at set or cleared to match, and moves the version; the
 * caller holds the row lock and has checked the transition (research R8).
 */
export async function setVendorStatus(
  tx: AuditedTransaction,
  id: string,
  status: VendorStatus,
): Promise<VendorRow> {
  const [row] = await tx.$queryRaw<VendorRow[]>`
    UPDATE vendors
       SET status = ${status},
           deactivated_at = CASE WHEN ${status === 'INACTIVE'} THEN now() END,
           version = version + 1
     WHERE id = ${id}::uuid
    RETURNING ${COLUMNS}`;
  if (!row) throw new Error(`Vendor ${id} vanished while locked`);
  return row;
}

/**
 * Reads the vendor under FOR SHARE for an order's active check (research R9), or null.
 * Shared holders don't block each other; a status change or edit (FOR UPDATE) waits.
 */
export async function lockVendorShared(
  tx: AuditedTransaction,
  id: string,
): Promise<VendorRow | null> {
  const [row] = await tx.$queryRaw<VendorRow[]>`
    SELECT ${COLUMNS} FROM vendors WHERE id = ${id}::uuid FOR SHARE`;
  return row ?? null;
}

export async function findVendor(prisma: AppPrismaClient, id: string): Promise<VendorRow | null> {
  const [row] = await prisma.$queryRaw<VendorRow[]>`
    SELECT ${COLUMNS} FROM vendors WHERE id = ${id}::uuid`;
  return row ?? null;
}

export interface VendorListFilter {
  status: VendorStatusFilter;
  /** A name prefix, compared by name key. */
  q?: string | undefined;
}

/**
 * The highest code point (U+10FFFF, a noncharacter): every name key that starts with `key`
 * sorts below `key || chr(MAX_CHAR)`, unless that very character follows the prefix.
 */
const MAX_CHAR = 1_114_111;

/**
 * The filter in SQL. The prefix is a range on the "C"-collated name_key, from the key of
 * `q` to that key plus the highest code point, so an index serves it even under a generic
 * plan, and `%` or `_` in `q` mean themselves (research R11).
 */
function whereOf(filter: VendorListFilter): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filter.status !== 'ALL') conditions.push(Prisma.sql`status = ${filter.status}`);
  if (filter.q !== undefined) {
    conditions.push(Prisma.sql`name_key >= vendor_name_key(${filter.q})
      AND name_key < vendor_name_key(${filter.q}) || chr(${MAX_CHAR}::int)`);
  }
  return conditions.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.empty;
}

/**
 * A page of vendors sorted by name key. The key is unique (vendors_name_key_key), so it is
 * a total order and both name-key indexes serve it with no sort.
 */
export function listVendors(
  prisma: AppPrismaClient,
  filter: VendorListFilter & { offset: number; limit: number },
): Promise<VendorRow[]> {
  return prisma.$queryRaw<VendorRow[]>`
    SELECT ${COLUMNS} FROM vendors ${whereOf(filter)}
     ORDER BY vendors.name_key
     LIMIT ${filter.limit} OFFSET ${filter.offset}`;
}

export async function countVendors(
  prisma: AppPrismaClient,
  filter: VendorListFilter,
): Promise<number> {
  const [row] = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT count(*) AS total FROM vendors ${whereOf(filter)}`;
  return Number(row?.total ?? 0);
}
