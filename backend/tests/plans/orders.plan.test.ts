import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import {
  AUDIT_ENTRY_COUNT,
  ORDER_COUNT,
  ORDER_ENTRY_COUNT,
  orderPlanIds,
  orderPlanQueries,
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

const TABLES = new Set(['purchase_orders', 'order_lines', 'audit_entries']);
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
const timings: Record<string, number> = {};

beforeAll(async () => {
  const started = performance.now();
  db = await createTestDatabase();
  const superuser = await db.client('postgres');
  app = await db.client('po_app');
  await seedOrderPlanData(superuser, app);
  timings.seedMs = Math.round(performance.now() - started);
  queries = orderPlanQueries(await orderPlanIds(app));
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
              (SELECT count(*)::int FROM audit_entries WHERE entity_type = 'order') AS order_entries`,
    );
    expect(rows[0]).toMatchObject({
      orders: ORDER_COUNT,
      entries: AUDIT_ENTRY_COUNT,
      order_entries: ORDER_ENTRY_COUNT,
    });
    expect(rows[0]?.lines).toBeGreaterThan(1_000_000);
    expect(rows[0]?.lines).toBeLessThan(1_200_000);
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
});
