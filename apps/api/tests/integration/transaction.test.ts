import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { ConcurrencyRetryExhaustedError, DatabaseUnavailableError } from '../../src/db/errors.js';
import {
  withDatabase,
  withTransaction,
  type ActorContext,
  type TransactionOptions,
} from '../../src/db/transaction.js';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

const operator: ActorContext = { type: 'OPERATOR', osUser: 'tester', host: 'ci-host' };
const clients: AppPrismaClient[] = [];

async function setup(
  overrides: Partial<TransactionOptions> & { poolSize?: number; connectionTimeoutMs?: number } = {},
) {
  const db = trackDatabase(await createTestDatabase());
  const prisma = createPrismaClient({
    url: db.url('po_app'),
    poolSize: overrides.poolSize ?? 2,
    connectionTimeoutMs: overrides.connectionTimeoutMs ?? 2_000,
  });
  clients.push(prisma);
  const options: TransactionOptions = {
    prisma,
    actor: operator,
    requestId: 'req-test-0001',
    timeoutMs: overrides.timeoutMs ?? 5_000,
    maxWaitMs: overrides.maxWaitMs ?? 2_000,
    retry: overrides.retry ?? { retries: 3, baseDelayMs: 1 },
  };
  return { prisma, options };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

const raiseSqlstate = (code: string) =>
  `DO $$ BEGIN RAISE EXCEPTION 'probe' USING ERRCODE = '${code}'; END $$`;

async function currentSetting(prisma: AppPrismaClient, name: string) {
  const rows = await prisma.$queryRawUnsafe<{ value: string | null }[]>(
    `SELECT current_setting('${name}', true) AS value`,
  );
  return rows[0]?.value ?? null;
}

describe('[NFR-AUD-02] actor context', () => {
  it('is visible inside the transaction and gone after commit, on the same connection', async () => {
    const { prisma, options } = await setup({ poolSize: 1 });
    const inside = await withTransaction(options, async (tx) => {
      return tx.$queryRaw<{ actor: string; host: string; request: string }[]>`
        SELECT current_setting('app.actor_type') AS actor,
               current_setting('app.os_host') AS host,
               current_setting('app.request_id') AS request`;
    });
    expect(inside[0]).toEqual({ actor: 'OPERATOR', host: 'ci-host', request: 'req-test-0001' });
    expect(await currentSetting(prisma, 'app.actor_type')).toBeFalsy();
  });

  it('is gone after rollback', async () => {
    const { prisma, options } = await setup({ poolSize: 1 });
    await expect(withTransaction(options, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(await currentSetting(prisma, 'app.actor_type')).toBeFalsy();
  });

  it('sets the user fields for a USER actor and leaves operator fields empty', async () => {
    const { options } = await setup();
    const user: ActorContext = {
      type: 'USER',
      userId: '018f6f7e-0000-7000-8000-000000000001',
      name: 'Asha',
      email: 'asha@example.local',
      actingRole: 'ADMIN',
    };
    const rows = await withTransaction(
      { ...options, actor: user },
      (tx) =>
        tx.$queryRaw<{ id: string; role: string; os: string }[]>`
        SELECT current_setting('app.actor_user_id') AS id,
               current_setting('app.acting_role') AS role,
               current_setting('app.os_user') AS os`,
    );
    expect(rows[0]).toEqual({ id: user.userId, role: 'ADMIN', os: '' });
  });
});

describe('[NFR-CON-01] retries of serialization failures and deadlocks', () => {
  it('retries 40001 and 40P01 and returns the result once an attempt succeeds', async () => {
    const { options } = await setup();
    let attempts = 0;
    const result = await withTransaction(options, async (tx) => {
      attempts += 1;
      if (attempts === 1) await tx.$executeRawUnsafe(raiseSqlstate('40001'));
      if (attempts === 2) await tx.$executeRawUnsafe(raiseSqlstate('40P01'));
      return 'done';
    });
    expect(result).toBe('done');
    expect(attempts).toBe(3);
  });

  it('gives up after 3 retries with CONCURRENCY_RETRY_EXHAUSTED', async () => {
    const { options } = await setup();
    let attempts = 0;
    const failing = withTransaction(options, async (tx) => {
      attempts += 1;
      await tx.$executeRawUnsafe(raiseSqlstate('40001'));
    });
    await expect(failing).rejects.toBeInstanceOf(ConcurrencyRetryExhaustedError);
    await expect(failing).rejects.toMatchObject({ code: 'CONCURRENCY_RETRY_EXHAUSTED' });
    expect(attempts).toBe(4);
  });

  it('does not retry other errors', async () => {
    const { options } = await setup();
    let attempts = 0;
    await expect(
      withTransaction(options, async (tx) => {
        attempts += 1;
        await tx.$executeRawUnsafe(raiseSqlstate('22012'));
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe('[NFR-OPS-04] afterCommit', () => {
  it('runs callbacks once, after commit, and only those of the attempt that committed', async () => {
    const { options } = await setup();
    const calls: string[] = [];
    let attempts = 0;
    await withTransaction(options, async (tx, { afterCommit }) => {
      attempts += 1;
      afterCommit(() => {
        calls.push(`attempt-${String(attempts)}`);
      });
      if (attempts === 1) await tx.$executeRawUnsafe(raiseSqlstate('40001'));
      calls.push('body-finished');
    });
    expect(calls).toEqual(['body-finished', 'attempt-2']);
  });

  it('never runs callbacks after rollback', async () => {
    const { options } = await setup();
    let called = false;
    await expect(
      withTransaction(options, (_tx, { afterCommit }) => {
        afterCommit(() => {
          called = true;
        });
        return Promise.reject(new Error('rolled back'));
      }),
    ).rejects.toThrow('rolled back');
    expect(called).toBe(false);
  });

  it('swallows a failing callback so the committed result still returns', async () => {
    const { options } = await setup();
    const result = await withTransaction(options, (_tx, { afterCommit }) => {
      afterCommit(() => Promise.reject(new Error('smtp down')));
      return Promise.resolve(42);
    });
    expect(result).toBe(42);
  });
});

describe('[NFR-CON-02] pool exhaustion and timeouts map to SERVICE_UNAVAILABLE', () => {
  it('maps pg-pool timeout on a query outside a transaction', async () => {
    const { prisma, options } = await setup({ poolSize: 1, connectionTimeoutMs: 300 });
    const hold = withTransaction(
      { ...options, timeoutMs: 10_000 },
      (tx) => tx.$queryRaw`SELECT pg_sleep(1.5)::text`,
    );
    await new Promise((r) => setTimeout(r, 200));
    const outside = withDatabase(() => prisma.$queryRaw`SELECT 1`);
    await expect(outside).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(outside).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await hold;
  });

  it('maps P2028 when a transaction waits past maxWait', async () => {
    const { options } = await setup({ poolSize: 1, connectionTimeoutMs: 5_000 });
    const hold = withTransaction(
      { ...options, timeoutMs: 10_000 },
      (tx) => tx.$queryRaw`SELECT pg_sleep(1.5)::text`,
    );
    await new Promise((r) => setTimeout(r, 200));
    const waiting = withTransaction({ ...options, maxWaitMs: 200 }, (tx) => tx.$queryRaw`SELECT 1`);
    await expect(waiting).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await hold;
  });

  it('maps P2028 when a transaction runs past its timeout', async () => {
    const { options } = await setup();
    const slow = withTransaction({ ...options, timeoutMs: 200 }, async (tx) => {
      await tx.$queryRaw`SELECT pg_sleep(0.6)::text`;
      await tx.$queryRaw`SELECT 1`;
    });
    await expect(slow).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });
});
