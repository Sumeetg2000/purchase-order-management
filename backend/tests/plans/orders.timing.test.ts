import {
  approvalQueueQuery,
  createOrderBody,
  editOrderBody,
  ORDER_LINES_MAX,
  orderListQuery,
  recordReceiptBody,
  type Order,
} from '@po/contracts';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApprovalsService, type ApprovalsService } from '../../src/approvals/service.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { systemClock } from '../../src/lib/clock.js';
import { createOrdersService, type OrdersService } from '../../src/orders/service.js';
import { createReceiptsService, type ReceiptsService } from '../../src/receipts/service.js';
import { createReportsService, type ReportsService } from '../../src/reports/service.js';
import { testClock } from '../support/clock.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { testLogger } from '../support/log-capture.js';
import { ORDER_COUNT, orderPlanIds, seedOrderPlanData } from './orders-fixture.js';

// The order and approval services' timings on the plan fixture (FR-022, SC-005, SC-006,
// ADR-0012): raising, replacing and submitting a 500-line order within 500 ms; the busiest
// Buyer's first page, one approval, one cancel and the approval queue's first page within
// 150 ms; a receipt of one line within 150 ms and of 500 lines within 500 ms (slice 6); at
// the 95th percentile, through the services as the API calls them. Results are printed for
// research R7 (slice 4), R8 (slice 5), the slice 6 quickstart results and slice 7's
// report and vendor summary (200 and 300 ms).

const WRITE_P95_MS = 500;
const LIST_P95_MS = 150;
const DECISION_P95_MS = 150;
/** ADR-0012: the outstanding report's page and its vendor summary. */
const REPORT_P95_MS = 200;
const VENDOR_SUMMARY_P95_MS = 300;
const WARM_UP_RUNS = 3;
/** Timed runs per measurement, after the warm-up: writes, decisions and pages alike. */
const TIMED_RUNS = 50;

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
function fullLines(tag: string, unitPrice = '12.3456') {
  return Array.from({ length: ORDER_LINES_MAX }, (_, i) => ({
    description: `Timed part ${tag}-${String(i + 1)}`,
    quantity: (i % 9) + 1,
    unitPrice,
  }));
}

let db: TestDatabase;
let app: pg.Client;
let prisma: AppPrismaClient;
let orders: OrdersService;
let approvals: ApprovalsService;
let receipts: ReceiptsService;
let reports: ReportsService;
let reportAsOf: string;
let buyer: Parameters<OrdersService['createOrder']>[0];
let approver: Parameters<ApprovalsService['approveOrder']>[0];
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
  reportAsOf = ids.asOf;
  const { rows } = await app.query<{ name: string; email: string }>(
    'SELECT name, email FROM users WHERE id = $1',
    [ids.buyer],
  );
  const user = rows[0];
  if (!user) throw new Error('no busiest Buyer');
  const { rows: approvers } = await app.query<{ name: string; email: string }>(
    'SELECT name, email FROM users WHERE id = $1',
    [ids.approver],
  );
  const planApprover = approvers[0];
  if (!planApprover) throw new Error('no plan Approver');
  approver = {
    userId: ids.approver,
    sessionId: randomUUID(),
    name: planApprover.name,
    email: planApprover.email,
    roles: ['APPROVER'],
  };
  buyer = {
    userId: ids.buyer,
    sessionId: randomUUID(),
    name: user.name,
    email: user.email,
    roles: ['BUYER'],
  };
  prisma = createPrismaClient({ url: db.url('po_app'), poolSize: 8, connectionTimeoutMs: 5_000 });
  const transactions = createTransactionRunner({ prisma, timeoutMs: 5_000, maxWaitMs: 5_000 });
  orders = createOrdersService({ prisma, transactions });
  approvals = createApprovalsService({ prisma, transactions });
  receipts = createReceiptsService({ prisma, transactions, clock: systemClock });
  // The report counts ages to the fixture's own as-of date (its latest approval's day).
  reports = createReportsService({
    prisma,
    clock: testClock(new Date(`${reportAsOf}T12:00:00+05:30`)),
  });
});

/** Today in India, the receipt date every timed receipt uses (approved today, too). */
function indiaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

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
    for (let run = 0; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
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
    for (let run = 0; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
      const page = await timed(run < WARM_UP_RUNS ? ignored : samples, () =>
        orders.listOrders(buyer, query),
      );
      expect(page.items.length).toBeGreaterThan(0);
    }
    results.busiestBuyerPageP95 = Math.round(p95(samples));
    expect(results.busiestBuyerPageP95).toBeLessThanOrEqual(LIST_P95_MS);
  });

  it('[NFR-PERF-01] submitting a 500-line order within 500 ms, approving and cancelling it within 150 ms each, p95', async () => {
    const submits: number[] = [];
    const approves: number[] = [];
    const cancels: number[] = [];
    const ignored: number[] = [];
    for (let run = 0; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
      const counted = run < WARM_UP_RUNS ? ignored : null;
      // Above the seeded tier, so the submit routes one step and the approve closes it.
      const body = createOrderBody.parse({
        vendorId,
        lines: fullLines(`s${String(run)}`, '1000'),
      });
      const { order } = await orders.createOrder(
        buyer,
        { body, idempotencyKey: randomUUID() },
        ctx(),
      );
      const pending = await timed(counted ?? submits, () =>
        approvals.submitOrder(buyer, { id: order.id, version: order.version }, ctx()),
      );
      expect(pending.status).toBe('PENDING_APPROVAL');
      const approved = await timed(counted ?? approves, () =>
        approvals.approveOrder(approver, { id: pending.id, version: pending.version }, ctx()),
      );
      expect(approved.status).toBe('APPROVED');
      // Slice 5: the cancel locks the order and the Approver's row, reads 500 lines for
      // PO_CANCELLED, and is held to the decision target (ADR-0012).
      const cancelled = await timed(counted ?? cancels, () =>
        approvals.cancelOrder(
          approver,
          { id: approved.id, version: approved.version, reason: 'Timing run' },
          ctx(),
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');
    }
    results.submitP95 = Math.round(p95(submits));
    results.approveP95 = Math.round(p95(approves));
    results.cancelP95 = Math.round(p95(cancels));
    expect(results.submitP95).toBeLessThanOrEqual(WRITE_P95_MS);
    expect(results.approveP95).toBeLessThanOrEqual(DECISION_P95_MS);
    expect(results.cancelP95).toBeLessThanOrEqual(DECISION_P95_MS);
  });

  it('[NFR-PERF-01] recording a receipt of 500 lines within 500 ms and of one line within 150 ms, p95', async () => {
    const fullReceipts: number[] = [];
    const oneLineReceipts: number[] = [];
    const ignored: number[] = [];
    const receivedOn = indiaToday();
    for (let run = 0; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
      const counted = run < WARM_UP_RUNS ? ignored : null;
      // ₹1 a unit, under the seeded tier: the submit approves it in the same transaction.
      const body = createOrderBody.parse({ vendorId, lines: fullLines(`g${String(run)}`, '1') });
      const { order } = await orders.createOrder(
        buyer,
        { body, idempotencyKey: randomUUID() },
        ctx(),
      );
      const approved = await approvals.submitOrder(
        buyer,
        { id: order.id, version: order.version },
        ctx(),
      );
      expect(approved.status).toBe('APPROVED');
      const lineIds = approved.lines.map((line) => line.id);
      // One unit of every line: the widest receipt there is.
      const everyLine = recordReceiptBody.parse({
        receivedOn,
        lines: lineIds.map((lineId) => ({ lineId, quantity: 1 })),
      });
      const full = await timed(counted ?? fullReceipts, () =>
        receipts.recordReceipt(
          buyer,
          { orderId: approved.id, body: everyLine, idempotencyKey: randomUUID() },
          ctx(),
        ),
      );
      expect(full.lines).toHaveLength(ORDER_LINES_MAX);
      // The second line ordered 2, so one unit is still outstanding on it.
      const oneLine = recordReceiptBody.parse({
        receivedOn,
        lines: [{ lineId: lineIds[1] ?? '', quantity: 1 }],
      });
      const single = await timed(counted ?? oneLineReceipts, () =>
        receipts.recordReceipt(
          buyer,
          { orderId: approved.id, body: oneLine, idempotencyKey: randomUUID() },
          ctx(),
        ),
      );
      expect(single.lines).toHaveLength(1);
    }
    results.receipt500P95 = Math.round(p95(fullReceipts));
    results.receipt1P95 = Math.round(p95(oneLineReceipts));
    expect(results.receipt500P95).toBeLessThanOrEqual(WRITE_P95_MS);
    expect(results.receipt1P95).toBeLessThanOrEqual(DECISION_P95_MS);
  });

  it('[NFR-PERF-01] the outstanding report, first page: p95 within 200 ms, for the Admin and the busiest Buyer', async () => {
    const callers = [
      ['reportAdminP95', { ...approver, roles: ['ADMIN'] as const }],
      ['reportBuyerP95', buyer],
    ] as const;
    for (const [name, caller] of callers) {
      const samples: number[] = [];
      const ignored: number[] = [];
      for (let run = 0; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
        const page = await timed(run < WARM_UP_RUNS ? ignored : samples, () =>
          reports.listOutstandingOrders(caller, { page: 1, pageSize: 20 }),
        );
        expect(page.asOf).toBe(reportAsOf);
        expect(page.items.length).toBeGreaterThan(0);
      }
      results[name] = Math.round(p95(samples));
      expect(results[name]).toBeLessThanOrEqual(REPORT_P95_MS);
    }
  });

  it('[NFR-PERF-01] the outstanding vendor summary, first page: p95 within 300 ms', async () => {
    const admin = { ...approver, roles: ['ADMIN'] as const };
    const samples: number[] = [];
    const ignored: number[] = [];
    for (let run = 0; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
      const page = await timed(run < WARM_UP_RUNS ? ignored : samples, () =>
        reports.listOutstandingVendors(admin, { page: 1, pageSize: 20 }),
      );
      expect(page.items.length).toBeGreaterThan(0);
    }
    results.vendorSummaryP95 = Math.round(p95(samples));
    expect(results.vendorSummaryP95).toBeLessThanOrEqual(VENDOR_SUMMARY_P95_MS);
  });

  it("[NFR-PERF-01] the Approver's queue, first page: p95 within 150 ms", async () => {
    const query = approvalQueueQuery.parse({});
    const samples: number[] = [];
    const ignored: number[] = [];
    for (let run = 0; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
      const page = await timed(run < WARM_UP_RUNS ? ignored : samples, () =>
        approvals.listApprovalQueue(approver, query),
      );
      expect(page.items.length).toBeGreaterThan(0);
    }
    results.queuePageP95 = Math.round(p95(samples));
    expect(results.queuePageP95).toBeLessThanOrEqual(LIST_P95_MS);
  });
});
