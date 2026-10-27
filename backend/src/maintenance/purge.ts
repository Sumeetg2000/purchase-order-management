import pg from 'pg';
import type { Logger } from 'pino';
import { AUDIT_RETENTION_YEARS } from '../audit/retention.js';
import type { AppPrismaClient } from '../db/client.js';
import { PURGE_LOCK } from '../db/locks.js';
import { ONE_SHOT } from '../db/one-shot.js';

/** How long one-time tokens are kept after use, supersession or expiry (ADR-0020). */
export const TOKEN_RETENTION_DAYS = 7;

/** Rows deleted per statement, so no single delete holds locks on a large set. */
export const PURGE_BATCH_SIZE = 1_000;

/** The tables the purge covers so far; later slices add sessions, keys and phones. */
export const PURGE_TABLES = ['audit_entries', 'one_time_tokens'] as const;
export type PurgeTable = (typeof PURGE_TABLES)[number];

export interface PurgeContext {
  db: AppPrismaClient;
  /**
   * The run's reference time: limits are measured back from it. Unset, it is the
   * database's now(), the clock the audit retention guard uses. Sent as ISO 8601 with its
   * Z offset: the adapter sends a Date as offset-less text, read in the session TimeZone.
   */
  asOf: Date | undefined;
  batchSize: number;
  /** Aborted when the run loses PURGE_LOCK: no further batch may start. */
  signal: AbortSignal;
}

/** One retention rule. `run` deletes what is past its limit and returns the row count. */
export interface PurgeTask {
  name: PurgeTable;
  run: (context: PurgeContext) => Promise<number>;
}

/**
 * Repeats a batch delete until one deletes fewer rows than a full batch. Each batch first
 * checks the run still holds its lock.
 */
async function deleteInBatches(
  { batchSize, signal }: Pick<PurgeContext, 'batchSize' | 'signal'>,
  deleteBatch: () => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    signal.throwIfAborted();
    const deleted = await deleteBatch();
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

// The audit_retention_guard trigger refuses any younger entry whatever this says, so asOf
// can't be used to delete inside the retention period. The order matches
// audit_entries_occurred_at_id_idx (migration 0003), so each batch is an index range scan.
export const auditEntriesTask: PurgeTask = {
  name: 'audit_entries',
  run: ({ db, asOf, batchSize, signal }) =>
    deleteInBatches(
      { batchSize, signal },
      () => db.$executeRaw`
        DELETE FROM audit_entries WHERE id IN (
          SELECT id FROM audit_entries
          WHERE occurred_at < COALESCE(${asOf?.toISOString() ?? null}::timestamptz, now()) - make_interval(years => ${AUDIT_RETENTION_YEARS})
          ORDER BY occurred_at, id
          LIMIT ${batchSize})`,
    ),
};

// The same COALESCE expression as one_time_tokens_purge_idx (migration 0005), so the
// index serves the purge.
export const oneTimeTokensTask: PurgeTask = {
  name: 'one_time_tokens',
  run: ({ db, asOf, batchSize, signal }) =>
    deleteInBatches(
      { batchSize, signal },
      () => db.$executeRaw`
        DELETE FROM one_time_tokens WHERE id IN (
          SELECT id FROM one_time_tokens
          WHERE COALESCE(used_at, superseded_at, expires_at)
            < COALESCE(${asOf?.toISOString() ?? null}::timestamptz, now()) - make_interval(days => ${TOKEN_RETENTION_DAYS})
          LIMIT ${batchSize})`,
    ),
};

export interface PurgeCycleResult {
  counts: Partial<Record<PurgeTable, number>>;
  failed: PurgeTable[];
}

/**
 * Runs every task once and logs one line per table with its count. A failing task is
 * logged and the rest still run; the run ends with one line listing each table's count:
 * "purge run complete", or "purge run failed" naming the tasks that failed.
 */
export async function runPurgeCycle(
  tasks: readonly PurgeTask[],
  context: PurgeContext,
  logger: Logger,
): Promise<PurgeCycleResult> {
  const counts: Partial<Record<PurgeTable, number>> = {};
  const failed: PurgeTable[] = [];
  for (const task of tasks) {
    try {
      const deleted = await task.run(context);
      counts[task.name] = deleted;
      logger.info({ table: task.name, deleted }, 'purge table done');
    } catch (error) {
      failed.push(task.name);
      logger.error({ err: error, task: task.name }, 'purge task failed');
    }
  }
  // Table names go in values, never keys: the logger redacts any key named like a token,
  // which one_time_tokens is.
  const tables = Object.entries(counts).map(([table, deleted]) => ({ table, deleted }));
  if (failed.length > 0) {
    logger.error({ tables, failed }, 'purge run failed');
  } else {
    logger.info({ tables }, 'purge run complete');
  }
  return { counts, failed };
}

export type PurgeOutcome =
  | ({ status: 'complete' | 'failed' } & Pick<PurgeCycleResult, 'counts'>)
  | { status: 'already_running' };

export interface PurgeOptions {
  tasks: readonly PurgeTask[];
  db: AppPrismaClient;
  /** The maintenance role's URL, for the connection that holds the run's lock. */
  lockUrl: string;
  logger: Logger;
  asOf?: Date;
  batchSize?: number;
}

/**
 * One purge run, one at a time (ADR-0020): PURGE_LOCK is a session-level advisory lock on
 * a dedicated connection, held for the whole run while the deletes commit batch by batch
 * on the pool. A run that finds it taken logs "already running" and deletes nothing. If
 * the process dies, its connection closes and PostgreSQL releases the lock.
 */
export async function runPurge({
  tasks,
  db,
  lockUrl,
  logger,
  asOf,
  batchSize = PURGE_BATCH_SIZE,
}: PurgeOptions): Promise<PurgeOutcome> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('the purge batch size must be a positive integer');
  }
  const lock = new pg.Client({
    connectionString: lockUrl,
    application_name: 'po_purge_lock',
    connectionTimeoutMillis: ONE_SHOT.connectionTimeoutMs,
  });
  // Losing the lock connection releases PURGE_LOCK, so the run must stop: another run may
  // now take the lock.
  const lockLost = new AbortController();
  lock.on('error', (error) => {
    logger.error({ err: error }, 'purge lock connection failed');
    lockLost.abort();
  });
  lock.on('end', () => {
    lockLost.abort();
  });
  await lock.connect();
  try {
    const { rows } = await lock.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [PURGE_LOCK.toString()],
    );
    if (rows[0]?.locked !== true) {
      logger.info('purge already running');
      return { status: 'already_running' };
    }
    const { counts, failed } = await runPurgeCycle(
      tasks,
      { db, asOf, batchSize, signal: lockLost.signal },
      logger,
    );
    return { status: failed.length > 0 ? 'failed' : 'complete', counts };
  } finally {
    // Ending the session releases the lock; an explicit unlock isn't needed.
    await lock.end().catch((error: unknown) => {
      logger.warn({ err: error }, 'purge lock connection did not close cleanly');
    });
  }
}
