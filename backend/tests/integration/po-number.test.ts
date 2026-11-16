import { PO_NUMBER_PATTERN } from '@po/contracts';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import {
  withTransaction,
  type AuditedTransaction,
  type TransactionOptions,
} from '../../src/db/transaction.js';
import { assignPoNumber } from '../../src/orders/po-number.js';
import { orderFixture, plant, type OrderFixture } from '../support/orders-sql.js';

// PO numbers (FR-002, research R2): PO-{FY}-{seq:06d}, by the Indian financial year in
// Asia/Kolkata, taken from a per-year counter row inside the create's transaction, so a
// create that rolls back takes no number. The clock is injected at the year boundary.

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

async function setup() {
  const f = await orderFixture();
  const prisma = createPrismaClient({
    url: f.db.url('po_app'),
    poolSize: 4,
    connectionTimeoutMs: 2_000,
  });
  clients.push(prisma);
  const options: TransactionOptions = {
    prisma,
    actor: { type: 'SYSTEM' },
    requestId: 'req-po-number',
    timeoutMs: 10_000,
    maxWaitMs: 5_000,
  };
  return { f, options };
}

/** Inserts a one-line draft in `tx` and gives it its number, as the create does last. */
async function draftWithNumber(tx: AuditedTransaction, f: OrderFixture, asOf?: Date) {
  const orderId = randomUUID();
  await tx.$executeRaw`INSERT INTO purchase_orders (id, owner_id, vendor_id)
    VALUES (${orderId}::uuid, ${f.buyerId}::uuid, ${f.vendorId}::uuid)`;
  await tx.$executeRaw`INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price)
    VALUES (${randomUUID()}::uuid, ${orderId}::uuid, 0, 'Bolts', 1, 1)`;
  return assignPoNumber(tx, orderId, asOf);
}

const IST_NEW_YEAR = new Date('2026-04-01T00:00:00+05:30');
const IST_YEAR_END = new Date('2026-03-31T23:59:59.999+05:30');

describe('[FR-PO-05] PO numbers', () => {
  it('[FR-PO-05] the first order of a financial year is 000001, then the next follows', async () => {
    const { f, options } = await setup();
    const first = await withTransaction(options, (tx) => draftWithNumber(tx, f, IST_NEW_YEAR));
    const second = await withTransaction(options, (tx) => draftWithNumber(tx, f, IST_NEW_YEAR));
    expect([first, second]).toEqual(['PO-2026-27-000001', 'PO-2026-27-000002']);
    expect(first).toMatch(PO_NUMBER_PATTERN);
  });

  it('[FR-PO-05] 31 March 23:59:59 IST and 1 April 00:00 IST fall in different years', async () => {
    const { f, options } = await setup();
    expect(await withTransaction(options, (tx) => draftWithNumber(tx, f, IST_YEAR_END))).toBe(
      'PO-2025-26-000001',
    );
    expect(await withTransaction(options, (tx) => draftWithNumber(tx, f, IST_NEW_YEAR))).toBe(
      'PO-2026-27-000001',
    );
    expect(await withTransaction(options, (tx) => draftWithNumber(tx, f, IST_YEAR_END))).toBe(
      'PO-2025-26-000002',
    );
  });

  it('[FR-PO-05] a create that rolls back takes no number: the next one gets it', async () => {
    const { f, options } = await setup();
    await withTransaction(options, (tx) => draftWithNumber(tx, f, IST_NEW_YEAR));
    await expect(
      withTransaction(options, async (tx) => {
        await draftWithNumber(tx, f, IST_NEW_YEAR);
        throw new Error('the create failed after its number');
      }),
    ).rejects.toThrow('the create failed after its number');
    expect(await withTransaction(options, (tx) => draftWithNumber(tx, f, IST_NEW_YEAR))).toBe(
      'PO-2026-27-000002',
    );
  });

  it('[FR-PO-05] without an injected time it uses the database clock', async () => {
    const { f, options } = await setup();
    const number = await withTransaction(options, (tx) => draftWithNumber(tx, f));
    const { rows } = await f.app.query<{ fy: string }>(`SELECT po_financial_year(now()) AS fy`);
    expect(number).toBe(`PO-${rows[0]?.fy ?? ''}-000001`);
  });

  it('[FR-PO-05] past 999,999 orders in a year the sequence grows a digit', async () => {
    const { f, options } = await setup();
    await plant(f, `INSERT INTO po_number_counters (fy, last_value) VALUES ('2026-27', 999999)`);
    expect(await withTransaction(options, (tx) => draftWithNumber(tx, f, IST_NEW_YEAR))).toBe(
      'PO-2026-27-1000000',
    );
  });

  it('[FR-PO-05] concurrent creates queue on the counter and get distinct, consecutive numbers', async () => {
    const { f, options } = await setup();
    const numbers = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTransaction(options, (tx) => draftWithNumber(tx, f, IST_NEW_YEAR)),
      ),
    );
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `PO-2026-27-${String(i + 1).padStart(6, '0')}`),
    );
  });
});
