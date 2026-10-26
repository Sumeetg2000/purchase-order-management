import type { AuditedTransaction } from './transaction.js';

// Transaction-scoped advisory lock keys (research R13, R15). Each names one thing only
// one process may do at a time; the lock is released at commit or rollback.

/** Creating or changing administrators: the bootstrap and the admin:* commands. */
export const ADMIN_LOCK = 7_310_001n;

/** The maintenance purge run. */
export const PURGE_LOCK = 7_310_002n;

/** Waits for ADMIN_LOCK until the transaction ends (or its timeout gives up). */
export async function lockAdmins(tx: AuditedTransaction): Promise<void> {
  // $executeRaw: pg_advisory_xact_lock returns void, which has no result type to read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_LOCK})`;
}
