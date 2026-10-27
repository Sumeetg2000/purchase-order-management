import type { AuditedTransaction } from './transaction.js';

// Transaction-scoped advisory lock keys (research R13, R15). Each names one thing only
// one process may do at a time; the lock is released at commit or rollback.

/** Creating or changing administrators: the bootstrap and the admin:* commands. */
export const ADMIN_LOCK = 7_310_001n;

/** The maintenance purge run. */
export const PURGE_LOCK = 7_310_002n;

/**
 * Takes ADMIN_LOCK for the rest of the transaction, waiting at most timeoutMs. A blocked
 * query never returns to Prisma, so its transaction timeout can't end the wait; the
 * transaction-local lock_timeout does, failing with 55P03 (DatabaseUnavailableError), and
 * the backend stops waiting. Keep it below the transaction's own timeout.
 */
export async function lockAdmins(
  tx: AuditedTransaction,
  { timeoutMs = 5_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${String(timeoutMs)}ms`}, true)`;
  // $executeRaw: pg_advisory_xact_lock returns void, which has no result type to read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_LOCK})`;
}
