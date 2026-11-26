import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import {
  CLOSED_REQUESTS,
  OPEN_REQUESTS,
  PLAN_EXCEPTIONS,
  USER_COUNT,
  seedUserPlanData,
  userPlanQueries,
} from './users-fixture.js';
import { literals, type PlanQuery } from './vendors-fixture.js';

// The Admin's user list and access-request list at ADR-0012's 10,000 users (slice 7,
// closing ADR-0021): every filter's page reads through an index and stops at the page,
// with the values bound and under a generic plan; no count reads rows it doesn't count.
// The owner accepted the scans named in PLAN_EXCEPTIONS (2026-11-26, ADR-0012); any other
// query that scans fails.
// EXPLAIN output is held in memory only; the committed shapes come from
// `npm run plans:users`.

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

const TABLES = new Set(['users', 'access_requests']);
const SORTS = new Set(['Sort', 'Incremental Sort']);

/** A page query's faults: a Seq Scan, or a Sort or filter over more than page plus offset. */
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

/** Problems of queries the owner has not accepted a scan for. */
function unaccepted(problems: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(problems).filter(([name]) => !(name in PLAN_EXCEPTIONS)),
  );
}

let db: TestDatabase;
let app: pg.Client;
let queries: PlanQuery[];

beforeAll(async () => {
  db = await createTestDatabase();
  const superuser = await db.client('postgres');
  app = await db.client('po_app');
  await seedUserPlanData(superuser);
  queries = userPlanQueries();
});

afterAll(async () => {
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

describe('[NFR-PERF-01] admin list plans at 10,000 users', () => {
  it('[NFR-PERF-01] holds 10,000 users across every status and role set, and their access requests', async () => {
    const { rows } = await app.query<{ users: number; roleSets: number; statuses: number }>(
      `SELECT count(*)::int AS users, count(DISTINCT roles)::int AS "roleSets",
              count(DISTINCT status)::int AS statuses FROM users`,
    );
    expect(rows[0]).toEqual({ users: USER_COUNT, roleSets: 5, statuses: 3 });
    const { rows: requests } = await app.query<{ status: string; n: number }>(
      `SELECT CASE WHEN status = 'OPEN' THEN 'OPEN' ELSE 'CLOSED' END AS status,
              count(*)::int AS n FROM access_requests GROUP BY 1 ORDER BY 1`,
    );
    expect(requests).toEqual([
      { status: 'CLOSED', n: CLOSED_REQUESTS },
      { status: 'OPEN', n: OPEN_REQUESTS },
    ]);
  });

  it('[NFR-PERF-01] page queries with bound values: through an index, nothing past the page', async () => {
    const problems: Record<string, string[]> = {};
    for (const query of queries.filter((q) => q.page)) {
      const found = pageProblems(await explain(query.sql.text, query.sql.values), query.rowsBound);
      if (found.length > 0) problems[query.name] = found;
    }
    expect(unaccepted(problems)).toEqual({});
  });

  it('[NFR-PERF-01] page queries as a prepared statement under a generic plan: the same', async () => {
    const problems: Record<string, string[]> = {};
    await app.query('SET plan_cache_mode = force_generic_plan');
    try {
      for (const query of queries.filter((q) => q.page)) {
        await app.query(`PREPARE plan_check AS ${query.sql.text}`);
        try {
          const found = pageProblems(
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
    expect(unaccepted(problems)).toEqual({});
  });

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
    expect(unaccepted(problems)).toEqual({});
  });

  it('[NFR-PERF-01] every accepted exception names a query this suite plans', () => {
    const names = new Set(queries.map((q) => q.name));
    expect(Object.keys(PLAN_EXCEPTIONS).filter((name) => !names.has(name))).toEqual([]);
  });
});
