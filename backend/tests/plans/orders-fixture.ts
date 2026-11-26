import {
  AGE_BUCKETS,
  APPROVAL_POLICY_SEED_TIERS,
  PAGE_SIZE_DEFAULT,
  RECEIPT_TIME_ZONE,
} from '@po/contracts';
import type pg from 'pg';
import { entityHistorySql } from '../../src/audit/repository.js';
import { readReconciliationSql } from '../../src/db/reconciliation.js';
import {
  openOrderCountsSql,
  orderListSql,
  type OrderListFilter,
  type OrderListScope,
} from '../../src/orders/repository.js';
import { approvalQueueSql, type QueueFilter } from '../../src/approvals/repository.js';
import { receiptLinesSql, receiptPageSql } from '../../src/receipts/repository.js';
import {
  outstandingReportSql,
  outstandingVendorsSql,
  type ReportFilter,
  type ReportScope,
} from '../../src/reports/repository.js';
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
/** ADR-0012's status mix (amended 2026-11-17 and 2026-11-20), by series number: n % 100
 * decides. */
export const STATUS_MIX = {
  APPROVED: 89_000,
  CANCELLED: 1_000,
  DRAFT: 5_000,
  PENDING_APPROVAL: 3_000,
  REJECTED: 2_000,
};
/**
 * Order 30,000 has 500 lines and the first 50 order entries: the busiest order. It is
 * approved and received in one 500-line receipt (slice 6: the widest receipt), and order
 * 30,011 is a draft in its place, so the status mix stays exact.
 */
export const HOT_ORDER = 30_000;
const HOT_SWAP = HOT_ORDER + 11;
/** A fully received order of three receipts: the receipt history's plan reads it. */
export const RECEIPT_ORDER = 1_013;

/**
 * ADR-0012's receipt mix (amended 2026-11-24, slice 6): of the approved orders, 45,000
 * fully received, 25,000 partly and 19,000 with nothing; of the cancelled, 500 partly and
 * 500 with nothing. 1–3 receipts per received order, about 1.5M receipt lines.
 */
export const RECEIPT_MIX = {
  'APPROVED FULLY_RECEIVED': 45_000,
  'APPROVED NOT_RECEIVED': 19_000,
  'APPROVED PARTIALLY_RECEIVED': 25_000,
  'CANCELLED NOT_RECEIVED': 500,
  'CANCELLED PARTIALLY_RECEIVED': 500,
};
const HOT_ORDER_ENTRIES = 50;
/** A later page: 99 pages of 20 skipped, so the plans show the offset's cost too. */
export const DEEP_PAGE = 100;
/** A realistic PO-number prefix (100 orders) and the shortest useful one (every order). */
export const PO_PREFIX = 'PO-2026-27-0012';
export const PO_PREFIX_SHORT = 'PO-2026-27-';

const buyerId = (n: string) => `md5('plan-buyer-' || ${n})::uuid`;
/** The one Approver (ADR-0012), and the top-10 Buyer who also holds APPROVER. */
const APPROVER_ID = `md5('plan-approver')::uuid`;
const DUAL_BUYER = 2;
/** The seeded policy's one tier (APPROVAL_POLICY_SEED_TIERS), in SQL. */
const SEED_TIER = APPROVAL_POLICY_SEED_TIERS[0];
/** Order n's status: 5 % drafts, 3 % pending, 2 % rejected, 1 % cancelled, the rest
 * approved (STATUS_MIX). */
const STATUS_OF = (n: string) =>
  `CASE WHEN ${n} = ${String(HOT_ORDER)} THEN 'APPROVED' WHEN ${n} = ${String(HOT_SWAP)} THEN 'DRAFT'
        WHEN ${n} % 100 < 5 THEN 'DRAFT' WHEN ${n} % 100 < 8 THEN 'PENDING_APPROVAL'
        WHEN ${n} % 100 < 10 THEN 'REJECTED' WHEN ${n} % 100 = 10 THEN 'CANCELLED'
        ELSE 'APPROVED' END`;
const vendorId = (n: string) => `md5('plan-order-vendor-' || ${n})::uuid`;
const orderId = (n: string) => `md5('plan-order-' || ${n})::uuid`;
/** Lines of order n: 200 to 500 for every 100th order, 1 to 15 for the rest. */
const lineCount = (n: string) =>
  `CASE WHEN ${n} % 100 = 0 THEN 200 + (${n} / 100) % 301 ELSE 1 + ${n} % 15 END`;

const FULL_SAMPLE_STATISTICS_TARGET = 10_000;
const TABLES =
  'users, vendors, purchase_orders, order_lines, audit_entries, approval_rounds, approval_steps, goods_receipts, goods_receipt_lines';

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
            1 + p % 9,
            -- Pending and rejected orders lie above the seeded tier (ADR-0002).
            CASE WHEN ${STATUS_OF('n')} IN ('PENDING_APPROVAL', 'REJECTED')
                 THEN 100001 + p ELSE ((n + p) % 100000) / 100.0 END
       FROM generate_series(1, ${String(ORDER_COUNT)}) AS n
       CROSS JOIN LATERAL generate_series(0, ${lineCount('n')} - 1) AS p`,
  );
  await superuser.query(
    `UPDATE purchase_orders o SET total = s.total, open_line_count = s.open_lines
       FROM (SELECT order_id, sum(line_total) AS total, count(*) AS open_lines
               FROM order_lines GROUP BY order_id) s
      WHERE o.id = s.order_id`,
  );
  // The one Approver, and a top-10 Buyer who also holds APPROVER (ADR-0012, 2026-11-17).
  await superuser.query(
    `INSERT INTO users (id, name, email, roles, status)
     VALUES (${APPROVER_ID}, 'Plan Approver', 'approver@plan.example', '{APPROVER}', 'ACTIVE')`,
  );
  await superuser.query(
    `UPDATE users SET roles = '{BUYER,APPROVER}' WHERE id = ${buyerId(String(DUAL_BUYER))}`,
  );
  // Statuses by series number (STATUS_MIX), each submitted an hour after it was raised
  // and decided an hour later, with a round and steps the consistency check accepts:
  // one step for a total above the seeded tier, an auto-approval otherwise.
  await superuser.query(
    `UPDATE purchase_orders o
        SET status = st.status, current_round = 1, submitted_at = o.created_at + interval '1 hour',
            approved_at = CASE WHEN st.status IN ('APPROVED', 'CANCELLED')
                               THEN o.created_at + interval '2 hours' END,
            -- A cancelled order: approved, then cancelled by the Approver an hour later.
            cancelled_by = CASE WHEN st.status = 'CANCELLED' THEN ${APPROVER_ID} END,
            cancelled_at = CASE WHEN st.status = 'CANCELLED'
                                THEN o.created_at + interval '3 hours' END,
            cancel_reason = CASE WHEN st.status = 'CANCELLED' THEN 'Supplier closed' END
       FROM (SELECT ${orderId('n')} AS id, ${STATUS_OF('n')} AS status
               FROM generate_series(1, ${String(ORDER_COUNT)}) AS n) st
      WHERE o.id = st.id AND st.status <> 'DRAFT'`,
  );
  await superuser.query(
    `INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot,
                                  submitted_by, submitted_at, outcome, closed_at)
     SELECT o.id, 1, 1, o.total,
            jsonb_build_object('id', v.id, 'name', v.name, 'contactName', v.contact_name,
                               'contactEmail', v.contact_email, 'contactPhone', v.contact_phone,
                               'paymentTerms', jsonb_build_object('type', 'NET', 'netDays', 30)),
            o.owner_id, o.submitted_at,
            CASE o.status WHEN 'PENDING_APPROVAL' THEN NULL
                          WHEN 'REJECTED' THEN 'REJECTED'
                          ELSE CASE WHEN o.total > ${SEED_TIER} THEN 'APPROVED'
                                    ELSE 'AUTO_APPROVED' END END,
            CASE WHEN o.status <> 'PENDING_APPROVAL' THEN o.created_at + interval '2 hours' END
       FROM purchase_orders o JOIN vendors v ON v.id = o.vendor_id
      WHERE o.status <> 'DRAFT'`,
  );
  await superuser.query(
    `INSERT INTO approval_steps (order_id, round, step, tier, threshold, state, decided_by,
                                 decided_at, decided_version, reason)
     SELECT r.order_id, 1, 1, 1, ${SEED_TIER},
            CASE o.status WHEN 'PENDING_APPROVAL' THEN 'OPEN' WHEN 'REJECTED' THEN 'REJECTED'
                          ELSE 'APPROVED' END,
            CASE WHEN o.status <> 'PENDING_APPROVAL' THEN ${APPROVER_ID} END,
            CASE WHEN o.status <> 'PENDING_APPROVAL' THEN r.closed_at END,
            CASE WHEN o.status <> 'PENDING_APPROVAL' THEN 1 END,
            CASE WHEN o.status = 'REJECTED' THEN 'Too dear' END
       FROM approval_rounds r JOIN purchase_orders o ON o.id = r.order_id
      WHERE r.total > ${SEED_TIER}`,
  );
  // Receipts (slice 6, RECEIPT_MIX), with the triggers off, so the received quantities,
  // open-line counts and audit entries are written here and checked by reconciliation.
  // Fully received: n % 100 from 11 to 55 among the approved, and the busiest order.
  // Partly: the first 25,000 other approved orders, and the first 500 cancelled, of more
  // than one line (one line of quantity 1 can't be partly received): every line but the
  // last received. A received order has 3 receipts (1 for n % 20 = 0, 2 for n % 20 = 1),
  // a day apart from its approval, splitting each line's quantity: about 1.5M receipt
  // lines from the million order lines.
  await superuser.query(
    `CREATE TEMP TABLE plan_receipt_orders AS
     WITH st AS (
       SELECT n, ${STATUS_OF('n')} AS status, ${lineCount('n')} AS lines
         FROM generate_series(1, ${String(ORDER_COUNT)}) AS n
     ), ranked AS (
       SELECT n, status, lines,
              (status = 'APPROVED' AND (n % 100 BETWEEN 11 AND 55 OR n = ${String(HOT_ORDER)}))
                AS full_receipt,
              row_number() OVER (PARTITION BY status,
                                 (status = 'APPROVED' AND (n % 100 BETWEEN 11 AND 55
                                                           OR n = ${String(HOT_ORDER)})),
                                 lines > 1
                                 ORDER BY n) AS rank
         FROM st WHERE status IN ('APPROVED', 'CANCELLED')
     )
     SELECT ${orderId('r.n')} AS id, r.n, r.lines,
            CASE WHEN r.n % 20 = 0 THEN 1 WHEN r.n % 20 = 1 THEN 2 ELSE 3 END AS k,
            CASE WHEN r.full_receipt THEN 'FULL'
                 WHEN r.lines > 1 AND r.status = 'APPROVED' AND r.rank <= 25000 THEN 'PART'
                 WHEN r.lines > 1 AND r.status = 'CANCELLED' AND r.rank <= 500 THEN 'PART'
            END AS kind
       FROM ranked r`,
  );
  await superuser.query(`DELETE FROM plan_receipt_orders WHERE kind IS NULL`);
  await superuser.query(
    `CREATE TEMP TABLE plan_receipt_lines AS
     SELECT md5('plan-receipt-' || ro.n || '-' || j)::uuid AS receipt_id, ro.id AS order_id,
            j, l.id AS line_id,
            l.quantity / ro.k + CASE WHEN j = 1 THEN l.quantity % ro.k ELSE 0 END AS quantity
       FROM plan_receipt_orders ro
       JOIN order_lines l ON l.order_id = ro.id
      CROSS JOIN LATERAL generate_series(1, ro.k) AS j
      WHERE (ro.kind = 'FULL' OR l.position < ro.lines - 1)
        AND l.quantity / ro.k + CASE WHEN j = 1 THEN l.quantity % ro.k ELSE 0 END > 0`,
  );
  await superuser.query(
    `INSERT INTO goods_receipts (id, order_id, received_on, recorded_at, recorded_by)
     SELECT DISTINCT rl.receipt_id, o.id,
            (o.approved_at AT TIME ZONE 'Asia/Kolkata')::date + rl.j,
            o.approved_at + rl.j * interval '1 day', o.owner_id
       FROM plan_receipt_lines rl JOIN purchase_orders o ON o.id = rl.order_id`,
  );
  await superuser.query(
    `INSERT INTO goods_receipt_lines (receipt_id, order_id, line_id, quantity)
     SELECT receipt_id, order_id, line_id, quantity FROM plan_receipt_lines`,
  );
  await superuser.query(
    `UPDATE order_lines l SET received_quantity = s.received
       FROM (SELECT line_id, sum(quantity) AS received FROM plan_receipt_lines GROUP BY line_id) s
      WHERE l.id = s.line_id`,
  );
  await superuser.query(
    `UPDATE purchase_orders o SET open_line_count = s.open_lines
       FROM (SELECT order_id, count(*) FILTER (WHERE received_quantity < quantity) AS open_lines
               FROM order_lines WHERE order_id IN (SELECT id FROM plan_receipt_orders)
              GROUP BY order_id) s
      WHERE o.id = s.order_id`,
  );
  await superuser.query(
    `INSERT INTO audit_entries (occurred_at, actor_type, action, entity_type, entity_id, order_id)
     SELECT r.recorded_at, 'SYSTEM', 'GOODS_RECEIPT_RECORDED', 'order', r.order_id::text,
            r.order_id
       FROM goods_receipt_lines gl JOIN goods_receipts r ON r.id = gl.receipt_id`,
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
  if (rows.length > 0) {
    throw new Error(
      `the plan data breaks ${String(rows.length)} invariants, e.g. ${JSON.stringify(rows.slice(0, 3))}`,
    );
  }
  await superuser.query(`SET default_statistics_target = ${String(FULL_SAMPLE_STATISTICS_TARGET)}`);
  await superuser.query(`VACUUM ANALYZE ${TABLES}`);
  await superuser.query('RESET default_statistics_target');
}

/** The ids the queries bind: the busiest Buyer, the busiest vendor, the busiest order. */
export async function orderPlanIds(client: pg.Client) {
  const { rows } = await client.query<{
    buyer: string;
    vendor: string;
    order: string;
    approver: string;
    dualApprover: string;
    receiptOrder: string;
    widestReceipt: string;
    asOf: string;
  }>(
    // The report's as-of date: the India date of the fixture's latest approval, so its
    // ages spread over the months the fixture's orders were raised in.
    `SELECT (SELECT ((max(approved_at) AT TIME ZONE '${RECEIPT_TIME_ZONE}')::date)::text
               FROM purchase_orders) AS "asOf",
            ${buyerId('1')}::text AS buyer, ${vendorId('1')}::text AS vendor,
            ${orderId(String(HOT_ORDER))}::text AS order, ${APPROVER_ID}::text AS approver,
            ${buyerId(String(DUAL_BUYER))}::text AS "dualApprover",
            ${orderId(String(RECEIPT_ORDER))}::text AS "receiptOrder",
            md5('plan-receipt-${String(HOT_ORDER)}-1')::uuid::text AS "widestReceipt"`,
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
  approver: string;
  dualApprover: string;
  receiptOrder: string;
  widestReceipt: string;
  asOf: string;
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
    // Slice 5: a rare status (1 %), which a walk of a status-free index would not stop on.
    ['cancelled', { status: 'CANCELLED' }],
    ['cancelled-vendor', { status: 'CANCELLED', vendorId: ids.vendor }],
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
  // The approval queue (slice 4 research R7): the one Approver, every pending order in
  // their queue; a dual-role top Buyer, whose own pending orders it leaves out.
  const queueCallers: [string, string][] = [
    ['approver', ids.approver],
    ['dual-approver', ids.dualApprover],
  ];
  const queueFilters: [string, QueueFilter][] = [
    ['all', {}],
    ['vendor', { vendorId: ids.vendor }],
    ['po-prefix', { poNumber: PO_PREFIX }],
    ['po-prefix-short', { poNumber: PO_PREFIX_SHORT }],
  ];
  for (const [callerName, caller] of queueCallers) {
    for (const [filterName, filter] of queueFilters) {
      const pages = callerName === 'approver' && filterName === 'all' ? [1, DEEP_PAGE] : [1];
      for (const page of pages) {
        const offset = (page - 1) * limit;
        queries.push({
          name: `approval-queue-${callerName}-${filterName}-page-${String(page)}`,
          sql: approvalQueueSql(caller, filter, { offset, limit }).page,
          page: true,
          rowsBound: limit + offset,
        });
      }
      queries.push({
        name: `approval-queue-${callerName}-${filterName}-count`,
        sql: approvalQueueSql(caller, filter, { offset: 0, limit }).count,
        page: false,
        rowsBound: 0,
      });
    }
  }

  // The receipt history (slice 6, research R10): a page of receipt summaries with their
  // line counts and its count, on an order of three receipts; one receipt's lines, on the
  // 500-line receipt.
  const receipts = receiptPageSql(ids.receiptOrder, { offset: 0, limit });
  queries.push({
    name: 'receipts-history-page-1',
    sql: receipts.page,
    page: true,
    rowsBound: limit,
  });
  queries.push({ name: 'receipts-history-count', sql: receipts.count, page: false, rowsBound: 0 });
  queries.push({
    name: 'receipt-lines-500',
    sql: receiptLinesSql(ids.widestReceipt),
    page: true,
    rowsBound: 500,
  });

  // The Admin's open-order counts for a user (slice 6, US6), at the busiest Buyer: read
  // through the owner's index, never more than that Buyer's own orders.
  queries.push({
    name: 'admin-open-orders',
    sql: openOrderCountsSql(ids.buyer),
    page: true,
    rowsBound: ORDER_COUNT / 40,
  });

  queries.push(...reportPlanQueries(ids));

  const timeline = entityHistorySql(entity, { offset: 0, limit });
  const [timelinePage, timelineCount] = [timeline.page, timeline.count];
  queries.push({ name: 'timeline-page-1', sql: timelinePage, page: true, rowsBound: limit });
  queries.push({ name: 'timeline-count', sql: timelineCount, page: false, rowsBound: 0 });
  return queries;
}

/** Which outstanding index each report query must walk (ADR-0015, amended 2026-11-26). */
export const REPORT_INDEXES = {
  all: 'purchase_orders_outstanding_idx',
  vendor: 'purchase_orders_outstanding_vendor_idx',
  own: 'purchase_orders_outstanding_owner_idx',
} as const;

/**
 * The outstanding report and vendor summary (slice 7, research R10): the page statement
 * (with each row's lines summed) and the count, for the Admin (every filter) and the
 * busiest Buyer, pages 1 and DEEP_PAGE; the summary for both. `index` names the partial
 * index the page must walk.
 */
export function reportPlanQueries(ids: {
  buyer: string;
  vendor: string;
  asOf: string;
}): (PlanQuery & { index?: string })[] {
  const limit = PAGE_SIZE_DEFAULT;
  const callers: [string, ReportScope, ReportFilter[]][] = [
    [
      'admin',
      { kind: 'all' },
      [{}, ...AGE_BUCKETS.map((ageBucket) => ({ ageBucket })), { vendorId: ids.vendor }],
    ],
    ['buyer', { kind: 'own', ownerId: ids.buyer }, [{}, { ageBucket: 'OVER_90' }]],
  ];
  const queries: (PlanQuery & { index?: string })[] = [];
  for (const [callerName, scope, filters] of callers) {
    for (const filter of [
      ...filters,
      ...(callerName === 'admin' ? [{ vendorId: ids.vendor, ageBucket: 'OVER_90' as const }] : []),
    ]) {
      const filterName =
        [
          filter.vendorId === undefined ? '' : 'vendor',
          filter.ageBucket?.toLowerCase().replaceAll('_', '-') ?? '',
        ]
          .filter(Boolean)
          .join('-') || 'all';
      const index =
        scope.kind === 'own'
          ? REPORT_INDEXES.own
          : filter.vendorId === undefined
            ? REPORT_INDEXES.all
            : REPORT_INDEXES.vendor;
      for (const page of [1, DEEP_PAGE]) {
        const offset = (page - 1) * limit;
        const sql = outstandingReportSql(scope, filter, ids.asOf, { offset, limit });
        queries.push({
          name: `report-${callerName}-${filterName}-page-${String(page)}`,
          sql: sql.statement,
          page: true,
          rowsBound: offset + limit,
          index,
        });
      }
      queries.push({
        name: `report-${callerName}-${filterName}-count`,
        sql: outstandingReportSql(scope, filter, ids.asOf, { offset: 0, limit }).count,
        page: false,
        rowsBound: 0,
      });
    }
    const summary = outstandingVendorsSql(scope, ids.asOf, { offset: 0, limit });
    // The summary aggregates every outstanding order in scope before it can order vendors
    // by their oldest approval: it may sort its groups, at most one per vendor (ADR-0012's
    // exception, signed off 2026-11-26), never orders.
    queries.push({
      name: `summary-${callerName}-page-1`,
      sql: summary.statement,
      page: true,
      rowsBound: VENDOR_COUNT,
      index: scope.kind === 'own' ? REPORT_INDEXES.own : REPORT_INDEXES.vendor,
    });
    queries.push({
      name: `summary-${callerName}-count`,
      sql: summary.count,
      page: false,
      rowsBound: 0,
    });
  }
  return queries;
}
