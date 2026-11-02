import type { AuditedTransaction } from './transaction.js';
import { ONE_SHOT } from './one-shot.js';

// Advisory lock keys (research R13, R15). Each names one thing only one process may do at
// a time.

/**
 * Creating or changing administrators: the bootstrap and the admin:* commands. Held for the
 * transaction, and released at commit or rollback.
 */
export const ADMIN_LOCK = 7_310_001n;

/**
 * The maintenance purge run. Held at session level on a dedicated connection for the
 * whole run (maintenance/purge.ts), since its deletes commit batch by batch.
 */
export const PURGE_LOCK = 7_310_002n;

/**
 * Takes ADMIN_LOCK for the rest of the transaction, waiting at most timeoutMs. A blocked
 * query never returns to Prisma, so its transaction timeout can't end the wait; the
 * transaction-local lock_timeout does, failing with 55P03 (DatabaseUnavailableError), and
 * the backend stops waiting. Keep it below the transaction's own timeout.
 */
export async function lockAdmins(
  tx: AuditedTransaction,
  { timeoutMs = ONE_SHOT.adminLockTimeoutMs }: { timeoutMs?: number } = {},
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${String(timeoutMs)}ms`}, true)`;
  // $executeRaw: pg_advisory_xact_lock returns void, which has no result type to read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_LOCK})`;
}
