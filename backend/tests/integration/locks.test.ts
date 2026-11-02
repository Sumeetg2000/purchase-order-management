import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { DatabaseUnavailableError } from '../../src/db/errors.js';
import { ADMIN_LOCK, lockAdmins } from '../../src/db/locks.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createTestDatabase } from '../support/db.js';
import { testLogger } from '../support/log-capture.js';
import { trackDatabase } from '../support/setup.js';

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

describe('[FR-ADM-05] ADMIN_LOCK', () => {
  it('[FR-ADM-05] a held lock makes the next taker give up after its lock timeout, leaving no backend waiting', async () => {
    const db = trackDatabase(await createTestDatabase());
    const holder = await db.client('po_app');
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_LOCK.toString()]);

    const prisma = createPrismaClient({
      url: db.url('po_app'),
      poolSize: 1,
      connectionTimeoutMs: 2_000,
    });
    clients.push(prisma);
    const started = Date.now();
    await expect(
      withTransaction(
        {
          prisma,
          actor: { type: 'SYSTEM' },
          requestId: 'req-lock-0001',
          timeoutMs: 5_000,
          maxWaitMs: 2_000,
          logger: testLogger(),
        },
        (tx) => lockAdmins(tx, { timeoutMs: 300 }),
      ),
    ).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(Date.now() - started).toBeLessThan(3_000);

    // The client is still alive: its backend must not still be queued on the lock.
    const admin = await db.client('postgres');
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
    );
    expect(rows[0]?.waiting).toBe(0);
    await holder.query('ROLLBACK');
  });
});
