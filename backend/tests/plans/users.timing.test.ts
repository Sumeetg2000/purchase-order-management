import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { seedUserPlanData, userPlanQueries } from './users-fixture.js';

// The Admin's user list and access-request list at 10,000 users (slice 1's SC-008, moved
// to slice 7 by ADR-0021): every filter's first page and every count within 200 ms at the
// 95th percentile, 50 timed runs after 3 warm-up, as po_app runs them. The plans these
// timings stand behind, scans included, are committed under docs/query-plans/admin/.

const LIST_P95_MS = 200;
const WARM_UP_RUNS = 3;
const TIMED_RUNS = 50;

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity;
}

let db: TestDatabase;
let app: pg.Client;
const results: Record<string, number> = {};

beforeAll(async () => {
  db = await createTestDatabase();
  const superuser = await db.client('postgres');
  app = await db.client('po_app');
  await seedUserPlanData(superuser);
});

afterAll(async () => {
  console.info(`admin list timings (ms, p95): ${JSON.stringify(results)}`);
  await db.drop();
});

describe('[NFR-PERF-01] admin list timings at 10,000 users', () => {
  it('[NFR-PERF-01] every first page and every count: p95 within 200 ms', async () => {
    const measured = userPlanQueries().filter((q) => !q.page || q.name.endsWith('-page-1'));
    for (const query of measured) {
      const samples: number[] = [];
      for (let run = 0; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
        const started = performance.now();
        await app.query(query.sql.text, query.sql.values);
        if (run >= WARM_UP_RUNS) samples.push(performance.now() - started);
      }
      results[query.name] = Math.round(p95(samples) * 10) / 10;
    }
    const over = Object.entries(results).filter(([, ms]) => ms > LIST_P95_MS);
    expect(over).toEqual([]);
  });
});
