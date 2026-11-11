import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import {
  AUDIT_ENTRY_COUNT,
  VENDOR_COUNT,
  VENDOR_ENTRY_COUNT,
  hotVendorId,
  literals,
  seedVendorPlanData,
  vendorPlanQueries,
  type PlanQuery,
} from './vendors-fixture.js';

// Vendor list and history plans at the ADR-0012 sizes (research R11, SC-006). The page
// queries never scan a whole table and never sort more rows than they return, both with
// the values bound as the API binds them and under a generic plan. EXPLAIN output is held
// in memory only; the committed shapes come from `npm run plans:vendors`.

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

const TABLES = new Set(['vendors', 'audit_entries']);
const SORTS = new Set(['Sort', 'Incremental Sort']);

/**
 * What a plan does wrong for a page query, as readable lines; none if it is fine. Besides
 * a Seq Scan and a Sort over more than page plus offset rows, an index scan that throws
 * away more rows than that is a whole-table walk in another form.
 */
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
  await seedVendorPlanData(superuser);
  timings.seedMs = Math.round(performance.now() - started);
  app = await db.client('po_app');
  queries = vendorPlanQueries(await hotVendorId(app));
});

afterAll(async () => {
  console.info(`vendor plans: ${JSON.stringify(timings)}`);
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

describe('[FR-VEN-01] vendor query plans at the ADR-0012 sizes', () => {
  it('[FR-VEN-01] holds the seeded sizes', async () => {
    const { rows } = await app.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM vendors) AS vendors,
              (SELECT count(*)::int FROM vendors WHERE status = 'INACTIVE') AS inactive,
              (SELECT count(*)::int FROM audit_entries) AS entries,
              (SELECT count(*)::int FROM audit_entries WHERE entity_type = 'vendor') AS vendor_entries`,
    );
    expect(rows[0]).toEqual({
      vendors: VENDOR_COUNT,
      inactive: VENDOR_COUNT / 10,
      entries: AUDIT_ENTRY_COUNT,
      vendor_entries: VENDOR_ENTRY_COUNT,
    });
  });

  it('[FR-VEN-01] page queries with bound values: no Seq Scan, no Sort beyond page plus offset', async () => {
    const started = performance.now();
    const problems: Record<string, string[]> = {};
    for (const query of queries.filter((q) => q.page)) {
      const found = pageProblems(await explain(query.sql.text, query.sql.values), query.rowsBound);
      if (found.length > 0) problems[query.name] = found;
    }
    timings.customPlansMs = Math.round(performance.now() - started);
    expect(problems).toEqual({});
  });

  it('[FR-VEN-01] page queries as a prepared statement under a generic plan: the same', async () => {
    const started = performance.now();
    const problems: Record<string, string[]> = {};
    await app.query('SET plan_cache_mode = force_generic_plan');
    try {
      for (const query of queries.filter((q) => q.page)) {
        await app.query(`PREPARE plan_check AS ${query.sql.text}`);
        try {
          const found = pageProblems(
            await explain(`EXECUTE plan_check(${literals(app, query.sql)})`),
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

  it('[FR-VEN-01] the history count reads the entity index, not the whole audit table', async () => {
    const history = queries.find((q) => q.name === 'history-count');
    if (!history) throw new Error('no history-count query');
    const plan = await explain(history.sql.text, history.sql.values);
    expect(
      nodes(plan)
        .filter((n) => n['Node Type'] === 'Seq Scan')
        .map((n) => n['Relation Name']),
    ).toEqual([]);
  });
});
