import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

// Regression test for research R5: the exact error shapes Prisma 7.10.1 with
// @prisma/adapter-pg 7.10.1 and pg 8.23.1 produce. db/errors.ts relies on these; an
// upgrade that changes any of them must fail here first.

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

async function client(
  options: { poolSize?: number; connectionTimeoutMs?: number; url?: string } = {},
) {
  const db = trackDatabase(await createTestDatabase());
  const prisma = createPrismaClient({
    url: options.url ?? db.url('po_app'),
    poolSize: options.poolSize ?? 2,
    connectionTimeoutMs: options.connectionTimeoutMs ?? 2_000,
  });
  clients.push(prisma);
  return prisma;
}

async function caught(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error('expected the promise to reject');
}

const cause = (error: Record<string, unknown>) =>
  (error['meta'] as { driverAdapterError?: { cause?: Record<string, unknown> } } | undefined)
    ?.driverAdapterError?.cause;

describe('[NFR-API-02] database error shapes (Prisma 7 + pg adapter)', () => {
  it('pool exhaustion outside a transaction is a bare pg-pool Error without a code', async () => {
    const prisma = await client({ poolSize: 1, connectionTimeoutMs: 300 });
    const hold = prisma.$transaction((tx) => tx.$queryRaw`SELECT pg_sleep(1.5)::text`, {
      timeout: 10_000,
      maxWait: 5_000,
    });
    await new Promise((r) => setTimeout(r, 200));
    const error = await caught(prisma.$queryRaw`SELECT 1`);
    expect(error).toBeInstanceOf(Error);
    expect(error['code']).toBeUndefined();
    expect(error['message']).toBe('timeout exceeded when trying to connect');
    await hold;
  });

  it('a transaction waiting past maxWait is P2028', async () => {
    const prisma = await client({ poolSize: 1, connectionTimeoutMs: 5_000 });
    const hold = prisma.$transaction((tx) => tx.$queryRaw`SELECT pg_sleep(1.5)::text`, {
      timeout: 10_000,
      maxWait: 5_000,
    });
    await new Promise((r) => setTimeout(r, 200));
    const error = await caught(
      prisma.$transaction((tx) => tx.$queryRaw`SELECT 1`, { maxWait: 200, timeout: 5_000 }),
    );
    expect(error['code']).toBe('P2028');
    await hold;
  });

  it('a transaction past its timeout is P2028 with timeout metadata', async () => {
    const prisma = await client();
    const error = await caught(
      prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_sleep(0.6)::text`;
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: 200, maxWait: 2_000 },
      ),
    );
    expect(error['code']).toBe('P2028');
    expect(error['meta']).toMatchObject({ timeout: 200 });
  });

  it.each(['40001', '40P01'])(
    'SQLSTATE %s is P2010 with TransactionWriteConflict',
    async (code) => {
      const prisma = await client();
      const error = await caught(
        prisma.$executeRawUnsafe(
          `DO $$ BEGIN RAISE EXCEPTION 'probe' USING ERRCODE = '${code}'; END $$`,
        ),
      );
      expect(error['code']).toBe('P2010');
      expect(cause(error)).toMatchObject({ kind: 'TransactionWriteConflict', originalCode: code });
    },
  );

  it('a custom SQLSTATE from our triggers arrives as cause.originalCode', async () => {
    const prisma = await client();
    const error = await caught(
      prisma.$executeRawUnsafe(
        `DO $$ BEGIN RAISE EXCEPTION 'ACTOR_CONTEXT_REQUIRED' USING ERRCODE = 'PO001'; END $$`,
      ),
    );
    expect(error['code']).toBe('P2010');
    expect(cause(error)).toMatchObject({ originalCode: 'PO001' });
  });

  it('an unreachable database is P2010 with DatabaseNotReachable', async () => {
    const db = trackDatabase(await createTestDatabase());
    const unreachable = db.url('po_app').replace(/:\d+\//, ':1/');
    const prisma = await client({ url: unreachable, connectionTimeoutMs: 500 });
    const error = await caught(prisma.$queryRaw`SELECT 1`);
    expect(error['code']).toBe('P2010');
    expect(cause(error)).toMatchObject({ kind: 'DatabaseNotReachable' });
  });
});
