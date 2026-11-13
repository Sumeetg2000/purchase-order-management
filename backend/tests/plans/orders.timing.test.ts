import {
  createOrderBody,
  editOrderBody,
  ORDER_LINES_MAX,
  orderListQuery,
  type Order,
} from '@po/contracts';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { createOrdersService, type OrdersService } from '../../src/orders/service.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { testLogger } from '../support/log-capture.js';
import { ORDER_COUNT, orderPlanIds, seedOrderPlanData } from './orders-fixture.js';

// The order service's timings on the plan fixture (FR-022, SC-005, ADR-0012): raising and
// replacing a 500-line order within 500 ms and the busiest Buyer's first page within
// 150 ms, at the 95th percentile, through the service as the API calls it. Results are
// printed for research R7.

const WRITE_P95_MS = 500;
const LIST_P95_MS = 150;
const WARM_UP_RUNS = 3;
const WRITE_RUNS = 20;
const LIST_RUNS = 50;

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity;
}

async function timed<T>(samples: number[], run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  samples.push(performance.now() - started);
  return result;
}

/** 500 lines; `tag` makes each set differ from the last, so a replace changes every line. */
function fullLines(tag: string) {
  return Array.from({ length: ORDER_LINES_MAX }, (_, i) => ({
    description: `Timed part ${tag}-${String(i + 1)}`,
    quantity: (i % 9) + 1,
    unitPrice: '12.3456',
  }));
}

let db: TestDatabase;
let app: pg.Client;
let prisma: AppPrismaClient;
let orders: OrdersService;
let buyer: Parameters<OrdersService['createOrder']>[0];
let vendorId: string;
const results: Record<string, number> = {};

beforeAll(async () => {
  db = await createTestDatabase();
  const superuser = await db.client('postgres');
  app = await db.client('po_app');
  await seedOrderPlanData(superuser, app);
  // The fixture writes its PO numbers directly; the year's counter continues after them.
  await superuser.query(
    `INSERT INTO po_number_counters (fy, last_value)
     VALUES (po_financial_year(now()), $1) ON CONFLICT (fy) DO UPDATE SET last_value = $1`,
    [ORDER_COUNT],
  );
  // The fixture's ids aren't RFC 4122 versions, which the contract requires of a vendorId:
  // the writes go to a vendor of their own.
  vendorId = randomUUID();
  await superuser.query('BEGIN');
  await superuser.query('SET LOCAL session_replication_role = replica');
  await superuser.query(
    `INSERT INTO vendors (id, name, contact_name, contact_email, payment_term_type, net_days)
     VALUES ($1, 'Timing Vendor', 'Contact', 'timing@vendor.example', 'NET', 30)`,
    [vendorId],
  );
  await superuser.query('COMMIT');
  const ids = await orderPlanIds(app);
  const { rows } = await app.query<{ name: string; email: string }>(
    'SELECT name, email FROM users WHERE id = $1',
    [ids.buyer],
  );
  const user = rows[0];
  if (!user) throw new Error('no busiest Buyer');
  buyer = {
    userId: ids.buyer,
    sessionId: randomUUID(),
    name: user.name,
    email: user.email,
    roles: ['BUYER'],
  };
  prisma = createPrismaClient({ url: db.url('po_app'), poolSize: 8, connectionTimeoutMs: 5_000 });
  orders = createOrdersService({
    prisma,
    transactions: createTransactionRunner({ prisma, timeoutMs: 5_000, maxWaitMs: 5_000 }),
  });
});

afterAll(async () => {
  console.info(`order service timings (ms, p95): ${JSON.stringify(results)}`);
  await prisma.$disconnect();
  await db.drop();
});

const ctx = () => ({
  requestId: randomUUID(),
  logger: testLogger(),
  ip: '10.0.0.1',
  userAgent: 'timing',
});

describe('[NFR-PERF-01] order service timings on the plan fixture', () => {
  it('[NFR-PERF-01] raising and replacing a 500-line order: p95 within 500 ms', async () => {
    const creates: number[] = [];
    const replaces: number[] = [];
    const ignored: number[] = [];
    for (let run = 0; run < WARM_UP_RUNS + WRITE_RUNS; run += 1) {
      const counted = run < WARM_UP_RUNS ? ignored : null;
      const body = createOrderBody.parse({ vendorId, lines: fullLines(`c${String(run)}`) });
      const { order } = await timed(counted ?? creates, () =>
        orders.createOrder(buyer, { body, idempotencyKey: randomUUID() }, ctx()),
      );
      // Every line replaced: 500 removed and 500 added, the edit's most work.
      const edit = editOrderBody.parse({ vendorId, lines: fullLines(`r${String(run)}`) });
      const replaced: Order = await timed(counted ?? replaces, () =>
        orders.editOrder(buyer, { id: order.id, version: order.version, body: edit }, ctx()),
      );
      expect(replaced.lineCount).toBe(ORDER_LINES_MAX);
    }
    results.createP95 = Math.round(p95(creates));
    results.replaceP95 = Math.round(p95(replaces));
    expect(results.createP95).toBeLessThanOrEqual(WRITE_P95_MS);
    expect(results.replaceP95).toBeLessThanOrEqual(WRITE_P95_MS);
  });

  it("[NFR-PERF-01] the busiest Buyer's first page: p95 within 150 ms", async () => {
    const query = orderListQuery.parse({});
    const samples: number[] = [];
    const ignored: number[] = [];
    for (let run = 0; run < WARM_UP_RUNS + LIST_RUNS; run += 1) {
      const page = await timed(run < WARM_UP_RUNS ? ignored : samples, () =>
        orders.listOrders(buyer, query),
      );
      expect(page.items.length).toBeGreaterThan(0);
    }
    results.busiestBuyerPageP95 = Math.round(p95(samples));
    expect(results.busiestBuyerPageP95).toBeLessThanOrEqual(LIST_P95_MS);
  });
});
