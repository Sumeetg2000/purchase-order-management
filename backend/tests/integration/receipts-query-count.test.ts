import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '../../src/auth/service.js';
import { createPrismaClient } from '../../src/db/client.js';
import { createTransactionRunner, type TransactionRunner } from '../../src/db/transaction.js';
import { createReceiptsService } from '../../src/receipts/service.js';
import { testClock } from '../support/clock.js';
import { testLogger } from '../support/log-capture.js';
import { orderFixture } from '../support/orders-sql.js';
import { approvalDate, approvedOrder } from '../support/receipts-sql.js';

// A receipt's statements (specs/007-goods-receipt/research.md R6): key claim, order lock,
// line lock and read, user lock, the receipt insert (header and lines, one CTE), the audit
// insert, key completion: 7, whatever the line count. Counted on the transaction the
// service gets, so the runner's own actor-context setup is not counted.

/** A runner whose transactions count the raw statements sent through them. */
function counting(runner: TransactionRunner) {
  let statements = 0;
  const counted: TransactionRunner = {
    run: (context, fn) =>
      runner.run(context, (tx, hooks) =>
        fn(
          new Proxy(tx, {
            get(target, key, receiver) {
              const value: unknown = Reflect.get(target, key, receiver);
              if (
                typeof key === 'string' &&
                /^\$(execute|query)Raw/.test(key) &&
                typeof value === 'function'
              ) {
                return (...args: unknown[]) => {
                  statements += 1;
                  return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
              }
              return value;
            },
          }),
          hooks,
        ),
      ),
  };
  return { runner: counted, statements: () => statements };
}

async function statementsFor(lineCount: number) {
  const f = await orderFixture();
  const { orderId, lineIds } = await approvedOrder(
    f,
    Array.from({ length: lineCount }, () => ({ quantity: 5, unitPrice: '1' })),
  );
  const prisma = createPrismaClient({
    url: f.db.url('po_app'),
    poolSize: 2,
    connectionTimeoutMs: 2_000,
  });
  try {
    const { runner, statements } = counting(
      createTransactionRunner({ prisma, timeoutMs: 20_000, maxWaitMs: 2_000 }),
    );
    const receipts = createReceiptsService({
      prisma,
      transactions: runner,
      clock: testClock(new Date()),
    });
    const buyer: AuthenticatedUser = {
      userId: f.buyerId,
      sessionId: randomUUID(),
      name: 'Bea Buyer',
      email: 'bea@example.local',
      roles: ['BUYER'],
    };
    const receipt = await receipts.recordReceipt(
      buyer,
      {
        orderId,
        idempotencyKey: randomUUID(),
        body: {
          receivedOn: await approvalDate(f.app, orderId),
          lines: lineIds.map((lineId) => ({ lineId, quantity: 1 })),
        },
      },
      { requestId: 'req-count-0001', logger: testLogger(), ip: '127.0.0.1', userAgent: 'test' },
    );
    expect(receipt.lines).toHaveLength(lineCount);
    return statements();
  } finally {
    await prisma.$disconnect();
  }
}

describe('[NFR-PERF-03] a receipt is 7 statements, whatever its line count', () => {
  it('[NFR-PERF-03] a 1-line receipt sends 7 statements', async () => {
    expect(await statementsFor(1)).toBe(7);
  });

  it('[NFR-PERF-03] a 500-line receipt sends 7 statements too', async () => {
    expect(await statementsFor(500)).toBe(7);
  });
});
