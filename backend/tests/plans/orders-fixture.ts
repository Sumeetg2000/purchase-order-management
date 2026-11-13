import { PAGE_SIZE_DEFAULT } from '@po/contracts';
import type pg from 'pg';
import { entityHistorySql } from '../../src/audit/repository.js';
import { readReconciliationSql } from '../../src/db/reconciliation.js';
import {
  orderListSql,
  type OrderListFilter,
  type OrderListScope,
} from '../../src/orders/repository.js';
import type { PlanQuery } from './vendors-fixture.js';

// The order query-plan data and queries (research R7), shared by the plan test and the plan
// writer (`npm run plans:orders`). Sizes from ADR-0012: 2,000 vendors (the top 20 hold
// about 30 % of orders), 300 Buyers (the top 10 about 25 %), 100,000 orders and about
// 1.1M lines (1 % of orders with 200 to 500 lines, the rest 1 to 15), and 2M audit
// entries, 300,000 of them order entries. Every value comes from the series number, so
// the data, and so the plans, are the same on every run.

export const ORDER_COUNT = 100_000;
export const BUYER_COUNT = 300;
export const VENDOR_COUNT = 2_000;
export const AUDIT_ENTRY_COUNT = 2_000_000;
export const ORDER_ENTRY_COUNT = 300_000;
/** Order 30,000 has 500 lines and the first 50 order entries: the busiest order. */
export const HOT_ORDER = 30_000;
const HOT_ORDER_ENTRIES = 50;
/** A later page: 99 pages of 20 skipped, so the plans show the offset's cost too. */
export const DEEP_PAGE = 100;
/** A realistic PO-number prefix (100 orders) and the shortest useful one (every order). */
export const PO_PREFIX = 'PO-2026-27-0012';
export const PO_PREFIX_SHORT = 'PO-2026-27-';

const buyerId = (n: string) => `md5('plan-buyer-' || ${n})::uuid`;
const vendorId = (n: string) => `md5('plan-order-vendor-' || ${n})::uuid`;
const orderId = (n: string) => `md5('plan-order-' || ${n})::uuid`;
/** Lines of order n: 200 to 500 for every 100th order, 1 to 15 for the rest. */
const lineCount = (n: string) =>
  `CASE WHEN ${n} % 100 = 0 THEN 200 + (${n} / 100) % 301 ELSE 1 + ${n} % 15 END`;

const FULL_SAMPLE_STATISTICS_TARGET = 10_000;
const TABLES = 'users, vendors, purchase_orders, order_lines, audit_entries';

/**
 * Seeds every table with one INSERT … SELECT each, as the superuser with row triggers off,
 * then sets each order's total and open-line count in one statement, checks them with the
 * committed reconciliation query, and VACUUM ANALYZEs at full sample.
 */
export async function seedOrderPlanData(superuser: pg.Client, app: pg.Client): Promise<void> {
  await superuser.query(
    TABLES.split(', ')
      .map((t) => `ALTER TABLE ${t} SET (autovacuum_enabled = false);`)
      .join(' '),
  );
  await superuser.query('BEGIN');
  await superuser.query('SET LOCAL session_replication_role = replica');
  await superuser.query(
    `INSERT INTO users (id, name, email, roles, status)
     SELECT ${buyerId('n')}, 'Buyer ' || n, 'buyer' || n || '@plan.example', '{BUYER}', 'ACTIVE'
       FROM generate_series(1, ${String(BUYER_COUNT)}) AS n`,
  );
  await superuser.query(
    `INSERT INTO vendors (id, name, contact_name, contact_email, payment_term_type, net_days)
     SELECT ${vendorId('n')}, 'Order Vendor ' || n, 'Contact ' || n,
            'contact' || n || '@vendor.example', 'NET', 30
       FROM generate_series(1, ${String(VENDOR_COUNT)}) AS n`,
  );
  // Every 4th order goes to one of the 10 busiest Buyers, every 10th of three to one of
  // the 20 busiest vendors. Five minutes apart from 1 April 2026 IST: about a year.
  await superuser.query(
    `INSERT INTO purchase_orders (id, po_number, owner_id, vendor_id, created_at, updated_at)
     SELECT ${orderId('n')}, 'PO-2026-27-' || lpad(n::text, 6, '0'),
            ${buyerId('CASE WHEN n % 4 = 0 THEN (n / 4) % 10 + 1 ELSE 11 + n % 290 END')},
            ${vendorId('CASE WHEN n % 10 < 3 THEN n % 20 + 1 ELSE 21 + n % 1980 END')},
            timestamptz '2026-04-01 00:00+05:30' + n * interval '5 minutes',
            timestamptz '2026-04-01 00:00+05:30' + n * interval '5 minutes'
       FROM generate_series(1, ${String(ORDER_COUNT)}) AS n`,
  );
  await superuser.query(
    `INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price)
     SELECT md5('plan-line-' || n || '-' || p)::uuid, ${orderId('n')}, p, 'Item ' || p,
            1 + p % 9, ((n + p) % 100000) / 100.0
       FROM generate_series(1, ${String(ORDER_COUNT)}) AS n
       CROSS JOIN LATERAL generate_series(0, ${lineCount('n')} - 1) AS p`,
  );
  await superuser.query(
    `UPDATE purchase_orders o SET total = s.total, open_line_count = s.open_lines
       FROM (SELECT order_id, sum(line_total) AS total, count(*) AS open_lines
               FROM order_lines GROUP BY order_id) s
      WHERE o.id = s.order_id`,
  );
  // Three entries in 20 are an order's: the first 50 the busiest order's, the rest round
  // the orders. The others are user entries.
  const orderEntry = `(n / 20) * 3 + n % 20`;
  await superuser.query(
    `INSERT INTO audit_entries (occurred_at, actor_type, action, entity_type, entity_id, order_id)
     SELECT timestamptz '2026-04-01' + n * interval '15 seconds', 'SYSTEM',
            CASE WHEN n % 20 < 3 THEN 'PO_EDITED' ELSE 'USER_UPDATED' END,
            CASE WHEN n % 20 < 3 THEN 'order' ELSE 'user' END,
            CASE WHEN n % 20 < 3
              THEN (CASE WHEN ${orderEntry} < ${String(HOT_ORDER_ENTRIES)}
                      THEN ${orderId(String(HOT_ORDER))}
                      ELSE ${orderId(`1 + (${orderEntry}) % ${String(ORDER_COUNT)}`)} END)::text
              ELSE md5('plan-user-' || n % 5000)::uuid::text END,
            CASE WHEN n % 20 < 3
              THEN (CASE WHEN ${orderEntry} < ${String(HOT_ORDER_ENTRIES)}
                      THEN ${orderId(String(HOT_ORDER))}
                      ELSE ${orderId(`1 + (${orderEntry}) % ${String(ORDER_COUNT)}`)} END) END
       FROM generate_series(1, ${String(AUDIT_ENTRY_COUNT)}) AS n`,
  );
  await superuser.query('COMMIT');
  // The seeded totals and line counts are the database's own rule (Principle I).
  const { rows } = await app.query(readReconciliationSql());
  if (rows.length > 0) throw new Error(`the plan data breaks ${String(rows.length)} invariants`);
  await superuser.query(`SET default_statistics_target = ${String(FULL_SAMPLE_STATISTICS_TARGET)}`);
  await superuser.query(`VACUUM ANALYZE ${TABLES}`);
  await superuser.query('RESET default_statistics_target');
}

/** The ids the queries bind: the busiest Buyer, the busiest vendor, the busiest order. */
export async function orderPlanIds(client: pg.Client) {
  const { rows } = await client.query<{ buyer: string; vendor: string; order: string }>(
    `SELECT ${buyerId('1')}::text AS buyer, ${vendorId('1')}::text AS vendor,
            ${orderId(String(HOT_ORDER))}::text AS order`,
  );
  const ids = rows[0];
  if (!ids) throw new Error('no plan ids');
  return ids;
}

/** Every order list and timeline query the API runs, with the values it binds. */
export function orderPlanQueries(ids: {
  buyer: string;
  vendor: string;
  order: string;
}): PlanQuery[] {
  const limit = PAGE_SIZE_DEFAULT;
  const scopes: [string, OrderListScope][] = [
    ['buyer', { kind: 'own', userId: ids.buyer }],
    ['buyer-approver', { kind: 'ownOrNonDraft', userId: ids.buyer }],
    ['approver', { kind: 'nonDraft' }],
    ['admin', { kind: 'all' }],
  ];
  const filters: [string, OrderListFilter][] = [
    ['all', {}],
    ['status', { status: 'DRAFT' }],
    ['vendor', { vendorId: ids.vendor }],
    ['po-prefix', { poNumber: PO_PREFIX }],
    ['po-prefix-short', { poNumber: PO_PREFIX_SHORT }],
    ['created', { createdFrom: '2026-06-01', createdTo: '2026-06-30' }],
    ['status-vendor', { status: 'DRAFT', vendorId: ids.vendor }],
    [
      'vendor-created',
      { vendorId: ids.vendor, createdFrom: '2026-06-01', createdTo: '2026-09-30' },
    ],
  ];
  const queries: PlanQuery[] = [];
  for (const [scopeName, scope] of scopes) {
    for (const [filterName, filter] of filters) {
      // A combined filter walks its leading filter's index and filters the rest (research
      // R7): it stops at page 1, but at a deep page it may sort the leading filter's
      // matches (one vendor's or one Buyer's orders), as no index holds both columns.
      const combined = Object.keys(filter).length > 1 && !('createdFrom' in filter);
      for (const page of combined ? [1] : [1, DEEP_PAGE]) {
        const offset = (page - 1) * limit;
        queries.push({
          name: `list-${scopeName}-${filterName}-page-${String(page)}`,
          sql: orderListSql(scope, filter, { offset, limit }).page,
          page: true,
          rowsBound: limit + offset,
        });
      }
      queries.push({
        name: `count-${scopeName}-${filterName}`,
        sql: orderListSql(scope, filter, { offset: 0, limit }).count,
        page: false,
        rowsBound: 0,
      });
    }
  }
  // The vendor-deactivation dialog's draft count: a page of one, read for its total.
  const dialog = orderListSql(
    { kind: 'own', userId: ids.buyer },
    { vendorId: ids.vendor, status: 'DRAFT' },
    { offset: 0, limit: 1 },
  );
  queries.push({ name: 'vendor-dialog-page', sql: dialog.page, page: true, rowsBound: 1 });
  queries.push({ name: 'vendor-dialog-count', sql: dialog.count, page: false, rowsBound: 0 });

  const entity = { entityType: 'order', entityId: ids.order } as const;
  const timeline = entityHistorySql(entity, { offset: 0, limit });
  const [timelinePage, timelineCount] = [timeline.page, timeline.count];
  queries.push({ name: 'timeline-page-1', sql: timelinePage, page: true, rowsBound: limit });
  queries.push({ name: 'timeline-count', sql: timelineCount, page: false, rowsBound: 0 });
  return queries;
}
