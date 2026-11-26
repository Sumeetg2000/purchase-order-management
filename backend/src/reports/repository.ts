import {
  AGE_BUCKET_UPPER_DAYS,
  AGE_BUCKETS,
  RECEIPT_TIME_ZONE,
  type AgeBucket,
  type OutstandingOrder,
  type OutstandingVendor,
} from '@po/contracts';
import { Prisma } from '../generated/prisma/client.js';
import type { AppPrismaClient } from '../db/client.js';
import type { PageArgs } from '../lib/pagination.js';
import { pageNumber } from '../orders/repository.js';

// The outstanding orders report (specs/008-outstanding-report, research R3–R5; ADR-0015
// amended 2026-11-26). Outstanding = approved with an open line, read from the stored
// open_line_count (INV-6) through the partial indexes of migration 0017. Ages are whole
// India calendar days to the as-of date, so every band is an approved_at range between
// India midnights and the index range is used. Receipts are never read; lines only for
// the page's rows.

/** Whose orders: a Buyer-only caller's own, or all (ADR-0004). */
export type ReportScope = { kind: 'own'; ownerId: string } | { kind: 'all' };

export interface ReportFilter {
  vendorId?: string | undefined;
  ageBucket?: AgeBucket | undefined;
}

/** The India midnight that starts the as-of date minus `days`. */
function startOf(asOf: string, days: number): Prisma.Sql {
  return Prisma.sql`((${asOf}::date - ${days}::int)::timestamp AT TIME ZONE ${RECEIPT_TIME_ZONE})`;
}

/**
 * A band's approved_at range. Band i holds ages from the previous band's upper bound + 1
 * to its own upper bound (inclusive): age ≤ U ⇔ approved on or after the India midnight
 * of asOf − U; age ≥ L ⇔ approved before the India midnight of asOf − L + 1.
 */
function bandRange(asOf: string, bucket: AgeBucket): Prisma.Sql {
  const i = AGE_BUCKETS.indexOf(bucket);
  const upper = AGE_BUCKET_UPPER_DAYS[i];
  const lowerAge = i === 0 ? undefined : (AGE_BUCKET_UPPER_DAYS[i - 1] ?? 0) + 1;
  const conditions: Prisma.Sql[] = [];
  if (upper !== undefined) conditions.push(Prisma.sql`o.approved_at >= ${startOf(asOf, upper)}`);
  if (lowerAge !== undefined) {
    conditions.push(Prisma.sql`o.approved_at < ${startOf(asOf, lowerAge - 1)}`);
  }
  return Prisma.join(conditions, ' AND ');
}

/** The band of an age expression, from the same constants. */
function bandOf(age: Prisma.Sql): Prisma.Sql {
  const cases = AGE_BUCKET_UPPER_DAYS.map(
    (upper, i) => Prisma.sql`WHEN ${age} <= ${upper}::int THEN ${AGE_BUCKETS[i] ?? ''}`,
  );
  return Prisma.sql`CASE ${Prisma.join(cases, ' ')} ELSE ${AGE_BUCKETS[AGE_BUCKETS.length - 1] ?? ''} END`;
}

/** Outstanding orders in scope, with the filters: the predicate every report query shares. */
function outstandingWhere(scope: ReportScope, filter: ReportFilter, asOf: string): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    // The partial indexes' own predicate, written the same way so the planner uses them.
    Prisma.sql`o.status = 'APPROVED' AND o.open_line_count > 0`,
  ];
  if (scope.kind === 'own') conditions.push(Prisma.sql`o.owner_id = ${scope.ownerId}::uuid`);
  if (filter.vendorId !== undefined) {
    conditions.push(Prisma.sql`o.vendor_id = ${filter.vendorId}::uuid`);
  }
  if (filter.ageBucket !== undefined) conditions.push(bandRange(asOf, filter.ageBucket));
  return Prisma.join(conditions, ' AND ');
}

const iso = (column: string) =>
  Prisma.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

export interface ReportSql {
  /** What the API runs: the page and the total in one statement, one snapshot. */
  statement: Prisma.Sql;
  /** Its parts, each planned on its own: for the plan tests and committed plans. */
  page: Prisma.Sql;
  count: Prisma.Sql;
}

/**
 * The report's SQL: the page walks the scope's partial index in (approved_at, id) order
 * to its rows and no further (a deferred join reads only the page's orders), then each
 * page row's lines are summed by the order-lines key.
 */
export function outstandingReportSql(
  scope: ReportScope,
  filter: ReportFilter,
  asOf: string,
  { offset, limit }: PageArgs,
): ReportSql {
  const where = outstandingWhere(scope, filter, asOf);
  const page = Prisma.sql`SELECT o.id, o.po_number, o.vendor_id, o.owner_id, o.created_at,
           o.approved_at, o.open_line_count
      FROM (SELECT o.approved_at, o.id FROM purchase_orders o WHERE ${where}
             ORDER BY o.approved_at, o.id
             LIMIT ${pageNumber(limit)} OFFSET ${pageNumber(offset)}) k
      JOIN purchase_orders o ON o.id = k.id`;
  const count = Prisma.sql`SELECT count(*) FROM purchase_orders o WHERE ${where}`;
  const approvedOn = Prisma.sql`(p.approved_at AT TIME ZONE ${RECEIPT_TIME_ZONE})::date`;
  // Never below 0: approved_at is the database's clock and asOf the API's, and near India
  // midnight the database may already be on the next day.
  const age = Prisma.sql`greatest(${asOf}::date - ${approvedOn}, 0)`;
  const statement = Prisma.sql`
    SELECT (${count})::int AS total,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', p.id::text,
                      'poNumber', p.po_number,
                      'vendor', json_build_object('id', v.id::text, 'name', v.name,
                                                  'status', v.status),
                      'owner', json_build_object('id', u.id::text, 'name', u.name),
                      'createdAt', ${iso('p.created_at')},
                      'approvedAt', ${iso('p.approved_at')},
                      'approvedOn', ${approvedOn}::text,
                      'ageDays', ${age},
                      'ageBucket', ${bandOf(age)},
                      'lineCount', l.line_count,
                      'openLineCount', p.open_line_count,
                      'outstandingQuantity', l.outstanding)
                    ORDER BY p.approved_at, p.id)
               FROM (${page}) p
               JOIN vendors v ON v.id = p.vendor_id
               JOIN users u ON u.id = p.owner_id
               -- The page row's lines, by the order-lines key: never another order's.
               CROSS JOIN LATERAL (
                 SELECT count(*)::int AS line_count,
                        sum(ol.quantity - ol.received_quantity)::int AS outstanding
                   FROM order_lines ol WHERE ol.order_id = p.id) l), '[]'::json) AS items`;
  return { statement, page, count };
}

/** One page of the report and its total, from one statement, so they always agree. */
export async function listOutstandingOrders(
  db: AppPrismaClient,
  scope: ReportScope,
  filter: ReportFilter,
  asOf: string,
  page: PageArgs,
): Promise<{ items: OutstandingOrder[]; total: number }> {
  const [row] = await db.$queryRaw<{ total: number; items: OutstandingOrder[] }[]>(
    outstandingReportSql(scope, filter, asOf, page).statement,
  );
  return { items: row?.items ?? [], total: row?.total ?? 0 };
}

/**
 * The vendor summary's SQL (research R5): the scope's outstanding orders grouped by vendor
 * over the partial index (index-only), a count per band from the same band ranges as the
 * report, and the oldest approval; then the groups (at most the vendors with anything
 * outstanding) are sorted oldest first and paged, and only the page's vendors are read.
 * Sorting the groups is the accepted exception to "no Sort over more than the page"
 * (ADR-0012, ADR-0015 amended 2026-11-26).
 */
export function outstandingVendorsSql(
  scope: ReportScope,
  asOf: string,
  { offset, limit }: PageArgs,
): ReportSql {
  const where = outstandingWhere(scope, {}, asOf);
  const bands = AGE_BUCKETS.map(
    (bucket) =>
      Prisma.sql`count(*) FILTER (WHERE ${bandRange(asOf, bucket)})::int AS ${Prisma.raw(`"${bucket}"`)}`,
  );
  const groups = Prisma.sql`SELECT o.vendor_id, count(*)::int AS order_count, ${Prisma.join(bands, ', ')},
           min(o.approved_at) AS oldest
      FROM purchase_orders o WHERE ${where} GROUP BY o.vendor_id`;
  const page = Prisma.sql`SELECT g.*, v.name, v.status
      FROM (${groups}) g JOIN vendors v ON v.id = g.vendor_id
     ORDER BY g.oldest, v.name, v.id
     LIMIT ${pageNumber(limit)} OFFSET ${pageNumber(offset)}`;
  const count = Prisma.sql`SELECT count(*) FROM (${groups}) g`;
  const byBucket = Prisma.join(
    AGE_BUCKETS.map((bucket) => Prisma.sql`${bucket}::text, p.${Prisma.raw(`"${bucket}"`)}`),
    ', ',
  );
  const statement = Prisma.sql`
    SELECT (${count})::int AS total,
           coalesce((
             SELECT json_agg(json_build_object(
                      'vendor', json_build_object('id', p.vendor_id::text, 'name', p.name,
                                                  'status', p.status),
                      'orderCount', p.order_count,
                      'byBucket', json_build_object(${byBucket}),
                      'oldestApprovedOn',
                        ((p.oldest AT TIME ZONE ${RECEIPT_TIME_ZONE})::date)::text)
                    ORDER BY p.oldest, p.name, p.vendor_id)
               FROM (${page}) p), '[]'::json) AS items`;
  return { statement, page, count };
}

/** One page of the vendor summary and its total, from one statement. */
export async function listOutstandingVendors(
  db: AppPrismaClient,
  scope: ReportScope,
  asOf: string,
  page: PageArgs,
): Promise<{ items: OutstandingVendor[]; total: number }> {
  const [row] = await db.$queryRaw<{ total: number; items: OutstandingVendor[] }[]>(
    outstandingVendorsSql(scope, asOf, page).statement,
  );
  return { items: row?.items ?? [], total: row?.total ?? 0 };
}
