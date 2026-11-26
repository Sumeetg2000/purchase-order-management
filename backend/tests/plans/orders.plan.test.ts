import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import {
  AUDIT_ENTRY_COUNT,
  ORDER_COUNT,
  ORDER_ENTRY_COUNT,
  RECEIPT_MIX,
  STATUS_MIX,
  orderPlanIds,
  orderPlanQueries,
  reportPlanQueries,
  seedOrderPlanData,
} from './orders-fixture.js';
import { literals, type PlanQuery } from './vendors-fixture.js';

// Order list and timeline plans at the ADR-0012 sizes (research R7, FR-022): every scope ×
// every filter reads through its index and stops at the page, both with the values bound
// as the API binds them and under a generic plan; no count reads a whole table. EXPLAIN
// output is held in memory only; the committed shapes come from `npm run plans:orders`.

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

const TABLES = new Set([
  'goods_receipts',
  'goods_receipt_lines',
  'purchase_orders',
  'order_lines',
  'audit_entries',
  'approval_rounds',
  'approval_steps',
]);
const SORTS = new Set(['Sort', 'Incremental Sort']);

/** A page query's faults: a Seq Scan, a Sort or a filter over more than page plus offset. */
function pageProblems(root: PlanNode, rowsBound: number): string[] {
  return nodes(root).flatMap((node) => {
    const loops = node['Actual Loops'] ?? 1;
    const table = node['Relation Name'];
    if (node['Node Type'] === 'Seq Scan' && table !== undefined && TABLES.has(table)) {
      return [`Seq Scan on ${table}`];
    }
    const removed = (node['Rows Removed by Filter'] ?? 0) * loops;
    if (table !== undefined && TABLES.has(table) && removed > rowsBound) {
      return [`${node['Node Type']} on ${table} filters out ${String(removed)} rows`];
    }
    if (SORTS.has(node['Node Type'])) {
      const input = node.Plans?.[0];
      const rows = (input?.['Actual Rows'] ?? 0) * (input?.['Actual Loops'] ?? 1);
      if (rows > rowsBound) {
        return [`${node['Node Type']} over ${String(rows)} rows (bound ${String(rowsBound)})`];
      }
    }
    return [];
  });
}

let db: TestDatabase;
let app: pg.Client;
let queries: PlanQuery[];
let ids: Awaited<ReturnType<typeof orderPlanIds>>;
const timings: Record<string, number> = {};

beforeAll(async () => {
  const started = performance.now();
  db = await createTestDatabase();
  const superuser = await db.client('postgres');
  app = await db.client('po_app');
  await seedOrderPlanData(superuser, app);
  timings.seedMs = Math.round(performance.now() - started);
  ids = await orderPlanIds(app);
  queries = orderPlanQueries(ids);
});

afterAll(async () => {
  console.info(`order plans: ${JSON.stringify(timings)}`);
  await db.drop();
});

async function explain(sql: string, values: unknown[] = []): Promise<PlanNode> {
  const { rows } = await app.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    values,
  );
  const plan = rows[0]?.['QUERY PLAN'][0]?.Plan;
  if (!plan) throw new Error('EXPLAIN returned no plan');
  return plan;
}

describe('[NFR-PERF-01] order query plans at the ADR-0012 sizes', () => {
  it('[NFR-PERF-01] holds the seeded sizes, about a million lines, and reconciles', async () => {
    const { rows } = await app.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM purchase_orders) AS orders,
              (SELECT count(*)::int FROM order_lines) AS lines,
              (SELECT count(*)::int FROM audit_entries) AS entries,
              (SELECT count(*)::int FROM audit_entries WHERE entity_type = 'order') AS order_entries,
              (SELECT count(*)::int FROM goods_receipt_lines) AS receipt_lines`,
    );
    // Each receipt line has its GOODS_RECEIPT_RECORDED entry, on top of the base entries.
    const receiptLines = rows[0]?.receipt_lines ?? 0;
    expect(rows[0]).toMatchObject({
      orders: ORDER_COUNT,
      entries: AUDIT_ENTRY_COUNT + receiptLines,
      order_entries: ORDER_ENTRY_COUNT + receiptLines,
    });
    expect(rows[0]?.lines).toBeGreaterThan(1_000_000);
    expect(rows[0]?.lines).toBeLessThan(1_200_000);
  });

  it("[NFR-PERF-01] holds ADR-0012's receipt mix: about 1.5M receipt lines, a 500-line receipt", async () => {
    const { rows } = await app.query<{ status: string; progress: string; n: number }>(
      `SELECT o.status,
              CASE WHEN o.open_line_count = 0 THEN 'FULLY_RECEIVED'
                   WHEN EXISTS (SELECT 1 FROM goods_receipts r WHERE r.order_id = o.id)
                     THEN 'PARTIALLY_RECEIVED'
                   ELSE 'NOT_RECEIVED' END AS progress,
              count(*)::int AS n
         FROM purchase_orders o WHERE o.status IN ('APPROVED', 'CANCELLED')
        GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(Object.fromEntries(rows.map((r) => [`${r.status} ${r.progress}`, r.n]))).toEqual(
      RECEIPT_MIX,
    );
    const [size] = await app
      .query<{ lines: number; receipts: number; widest: number }>(
        `SELECT (SELECT count(*)::int FROM goods_receipt_lines) AS lines,
              (SELECT count(*)::int FROM goods_receipts) AS receipts,
              (SELECT max(n)::int FROM (SELECT count(*) AS n FROM goods_receipt_lines
                                         GROUP BY receipt_id) w) AS widest`,
      )
      .then((r) => r.rows);
    expect(size?.lines).toBeGreaterThan(1_200_000);
    expect(size?.lines).toBeLessThan(1_800_000);
    expect(size?.widest).toBe(500);
  });

  it("[FR-ADM-02] the Admin's open-order counts at the busiest Buyer read the owner's indexes", async () => {
    const query = queries.find((q) => q.name === 'admin-open-orders');
    if (!query) throw new Error('no admin-open-orders query');
    const plan = await explain(query.sql.text, query.sql.values);
    // Draft and pending are counted on the owner's status index; approved with open lines
    // on the outstanding report's owner index (migration 0017), whose predicate is that
    // count's, so it no longer rechecks open_line_count in the table. None reads the table
    // in full.
    const all = nodes(plan) as (PlanNode & { 'Index Name'?: string })[];
    const indexes = all.flatMap((n) => (n['Index Name'] === undefined ? [] : [n['Index Name']]));
    expect(indexes).toEqual([
      'purchase_orders_owner_status_created_idx',
      'purchase_orders_owner_status_created_idx',
      'purchase_orders_outstanding_owner_idx',
    ]);
    expect(all.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual([]);
    expect(pageProblems(plan, query.rowsBound)).toEqual([]);
  });

  it("[NFR-PERF-01] holds ADR-0012's status mix, every pending order in one queue", async () => {
    const { rows } = await app.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM purchase_orders GROUP BY status ORDER BY status`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual(STATUS_MIX);
  });

  it('[NFR-PERF-01] page queries with bound values: through an index, nothing past the page', async () => {
    const started = performance.now();
    const problems: Record<string, string[]> = {};
    for (const query of queries.filter((q) => q.page)) {
      const found = pageProblems(await explain(query.sql.text, query.sql.values), query.rowsBound);
      if (found.length > 0) problems[query.name] = found;
    }
    timings.customPlansMs = Math.round(performance.now() - started);
    expect(problems).toEqual({});
  });

  it('[NFR-PERF-01] page queries as a prepared statement under a generic plan: the same', async () => {
    const started = performance.now();
    const problems: Record<string, string[]> = {};
    await app.query('SET plan_cache_mode = force_generic_plan');
    try {
      for (const query of queries.filter((q) => q.page)) {
        await app.query(`PREPARE plan_check AS ${query.sql.text}`);
        try {
          const found = pageProblems(
            // A query with no values (an Approver's unfiltered list) takes no parentheses.
            await explain(
              query.sql.values.length === 0
                ? 'EXECUTE plan_check'
                : `EXECUTE plan_check(${literals(app, query.sql)})`,
            ),
            query.rowsBound,
          );
          if (found.length > 0) problems[query.name] = found;
        } finally {
          await app.query('DEALLOCATE plan_check');
        }
      }
    } finally {
      await app.query('RESET plan_cache_mode');
    }
    timings.genericPlansMs = Math.round(performance.now() - started);
    expect(problems).toEqual({});
  });

  // A count reads every match, whatever the plan; what it must not do is read rows it
  // doesn't count. A count of nearly every order (an Admin's, all drafts, the short
  // prefix) may read the table itself: that reads only matches too.
  it('[NFR-PERF-01] counts read only the rows they count', async () => {
    const problems: Record<string, string[]> = {};
    for (const query of queries.filter((q) => !q.page)) {
      const plan = await explain(query.sql.text, query.sql.values);
      const found = nodes(plan).flatMap((n) => {
        const table = n['Relation Name'];
        const removed = (n['Rows Removed by Filter'] ?? 0) * (n['Actual Loops'] ?? 1);
        return table !== undefined && TABLES.has(table) && removed > 0
          ? [`${n['Node Type']} on ${table} reads ${String(removed)} rows it doesn't count`]
          : [];
      });
      if (found.length > 0) problems[query.name] = found;
    }
    expect(problems).toEqual({});
  });

  it("[FR-RPT-02] every age band has outstanding orders at the fixture's as-of date", async () => {
    const counts: Record<string, number> = {};
    for (const query of reportPlanQueries(ids).filter(
      (q) => /^report-admin-(days|over)/.test(q.name) && !q.page,
    )) {
      const { rows } = await app.query<{ count: string }>(query.sql.text, query.sql.values);
      counts[query.name] = Number(rows[0]?.count);
    }
    expect(Object.keys(counts)).toHaveLength(4);
    for (const [name, n] of Object.entries(counts)) expect(n, name).toBeGreaterThan(0);
  });

  it('[FR-RPT-02] the report and summary walk their outstanding index, never read receipts, and read lines only for page rows', async () => {
    const problems: Record<string, string[]> = {};
    for (const query of reportPlanQueries(ids).filter((q) => q.page)) {
      const all = nodes(await explain(query.sql.text, query.sql.values)) as (PlanNode & {
        'Index Name'?: string;
      })[];
      const found: string[] = [];
      const indexes = all.flatMap((n) => (n['Index Name'] === undefined ? [] : [n['Index Name']]));
      if (query.index !== undefined && !indexes.includes(query.index)) {
        found.push(`does not walk ${query.index} (walks ${indexes.join(', ')})`);
      }
      for (const n of all) {
        const table = n['Relation Name'];
        if (table === 'goods_receipts' || table === 'goods_receipt_lines')
          found.push(`reads ${table}`);
        // An index scan of a page row's lines, or a bitmap heap scan driven by one: keyed
        // on the order, never a scan of the table.
        if (table === 'order_lines') {
          const keyed = (m: PlanNode & { 'Index Cond'?: string }) =>
            /Index/.test(m['Node Type']) && (m['Index Cond'] ?? '').includes('order_id');
          const ok =
            keyed(n) ||
            (n['Node Type'] === 'Bitmap Heap Scan' && (n.Plans ?? []).every((m) => keyed(m)));
          if (!ok) found.push(`${n['Node Type']} on order_lines, not keyed on the order`);
        }
        // Lines are read once per page row, by the order-lines key.
        if (table === 'order_lines' && (n['Actual Loops'] ?? 1) > query.rowsBound) {
          found.push(`order_lines read ${String(n['Actual Loops'])} times`);
        }
      }
      if (found.length > 0) problems[query.name] = found;
    }
    expect(problems).toEqual({});
  });
});
