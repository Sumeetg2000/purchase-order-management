import { USER_STATUS, type UserStatus } from '@po/contracts';
import { revokeUserSessions } from '../auth/repository.js';
import { writeAudit } from '../audit/write.js';
import { lockAdmins } from '../db/locks.js';
import type { AuditedTransaction } from '../db/transaction.js';
import type { CliErrorCode } from '../lib/operator-codes.js';
import {
  countActiveAdmins,
  isAdmin,
  lockManagedUserByEmail,
  updateManagedUser,
} from './repository.js';

// Deactivating and reactivating an administrator, for admin:deactivate and
// admin:reactivate (ADR-0016, contracts/cli.md), inside the caller's OPERATOR transaction.
// The API never changes an admin, so ADMIN_LOCK alone serialises these changes.

/** A rule refused the change; nothing was written. The message never names the email. */
export class AdminStatusRefusedError extends Error {
  override readonly name = 'AdminStatusRefusedError';

  constructor(
    readonly code: Extract<CliErrorCode, 'LAST_ADMIN' | 'NOT_AN_ADMIN' | 'USER_NOT_FOUND'>,
  ) {
    super(`admin status change refused: ${code}`);
  }
}

export type AdminStatusChange =
  { changed: true; email: string; sessionsRevoked: number } | { changed: false; email: string };

/**
 * Sets an admin's status to ACTIVE or DEACTIVATED under ADMIN_LOCK. Deactivating ends
 * every session of theirs and refuses to leave no ACTIVE admin (LAST_ADMIN). No account with
 * the email is USER_NOT_FOUND; an account that isn't an admin is NOT_AN_ADMIN. Already in that status: nothing changes.
 */
export async function setAdminStatus(
  tx: AuditedTransaction,
  change: { email: string; status: Extract<UserStatus, 'ACTIVE' | 'DEACTIVATED'>; now: Date },
): Promise<AdminStatusChange> {
  await lockAdmins(tx);
  const email = change.email.toLowerCase();
  const admin = await lockManagedUserByEmail(tx, email);
  if (!admin) throw new AdminStatusRefusedError('USER_NOT_FOUND');
  if (!isAdmin(admin.roles)) throw new AdminStatusRefusedError('NOT_AN_ADMIN');
  if (admin.status === change.status) return { changed: false, email };

  const deactivating = change.status === USER_STATUS.DEACTIVATED;
  if (deactivating && (await countActiveAdmins(tx)) <= 1) {
    throw new AdminStatusRefusedError('LAST_ADMIN');
  }
  const updated = await updateManagedUser(tx, admin.id, {
    roles: admin.roles,
    status: change.status,
    previousStatus: admin.status,
    now: change.now,
  });
  const sessionsRevoked = deactivating
    ? await revokeUserSessions(tx, { id: admin.id, reason: 'DEACTIVATED', now: change.now })
    : 0;
  await writeAudit(tx, {
    action: deactivating ? 'USER_DEACTIVATED' : 'USER_REACTIVATED',
    entityType: 'user',
    entityId: admin.id,
    details: { before: admin.status, after: updated.status, sessionsRevoked },
  });
  return { changed: true, email, sessionsRevoked };
}
