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
 * The approval policy (slice 4 research R3, ADR-0006): set_approval_policy (migration
 * 0014, a pinned SQL copy) takes it exclusively, every submit shares it, so a submit and a
 * policy change never interleave. Held for the transaction.
 */
export const APPROVAL_POLICY_LOCK = 7_310_003n;

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
  await lockExclusively(tx, ADMIN_LOCK, timeoutMs);
}

/**
 * Takes APPROVAL_POLICY_LOCK exclusively for the rest of the transaction, as the admin
 * commands take ADMIN_LOCK: a submit in progress (which shares it) finishes first, or the
 * wait ends after timeoutMs with 55P03. set_approval_policy takes it again, re-entrantly.
 */
export async function lockApprovalPolicy(
  tx: AuditedTransaction,
  { timeoutMs = ONE_SHOT.adminLockTimeoutMs }: { timeoutMs?: number } = {},
): Promise<void> {
  await lockExclusively(tx, APPROVAL_POLICY_LOCK, timeoutMs);
}

async function lockExclusively(tx: AuditedTransaction, key: bigint, timeoutMs: number) {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${String(timeoutMs)}ms`}, true)`;
  // $executeRaw: pg_advisory_xact_lock returns void, which has no result type to read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key})`;
}
