import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '../../src/auth/service.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createReportsService } from '../../src/reports/service.js';
import { testClock } from '../support/clock.js';
import { orderFixture } from '../support/orders-sql.js';
import { approvedOrder } from '../support/receipts-sql.js';

// The report answers in one statement whatever the page size or its orders' line counts
// (Principle VII: the number of queries never grows with the page or the lines).

/** A client that counts the raw statements sent through it. */
function counting(prisma: AppPrismaClient) {
  let statements = 0;
  const counted = new Proxy(prisma, {
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
  });
  return { prisma: counted, statements: () => statements };
}

describe('[NFR-PERF-01] the outstanding report query count', () => {
  it('[NFR-PERF-01] one statement for a page of 1 or of 50, with orders of 1 or 40 lines', async () => {
    const f = await orderFixture();
    for (const lines of [1, 1, 40]) {
      await approvedOrder(
        f,
        Array.from({ length: lines }, () => ({ quantity: 5, unitPrice: '1' })),
      );
    }
    const prisma = createPrismaClient({
      url: f.db.url('po_app'),
      poolSize: 2,
      connectionTimeoutMs: 2_000,
    });
    try {
      const admin: AuthenticatedUser = {
        userId: randomUUID(),
        sessionId: randomUUID(),
        name: 'Ada Admin',
        email: 'ada@example.local',
        roles: ['ADMIN'],
      };
      for (const pageSize of [1, 50]) {
        const { prisma: counted, statements } = counting(prisma);
        const reports = createReportsService({ prisma: counted, clock: testClock(new Date()) });
        const page = await reports.listOutstandingOrders(admin, { page: 1, pageSize });
        expect(page.items, `page size ${String(pageSize)}`).toHaveLength(Math.min(pageSize, 3));
        expect(statements(), `page size ${String(pageSize)}`).toBe(1);
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});
