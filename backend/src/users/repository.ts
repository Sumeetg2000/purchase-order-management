import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';

// The minimal user repository slice 0 needs for the bootstrap and admin:create. Slice 1
// adds the rest (ADR-0016).

export interface UserSummary {
  id: string;
  email: string;
  roles: string[];
  status: string;
}

const SUMMARY = { id: true, email: true, roles: true, status: true } as const;

/** The user with this email (stored lower-cased), or null. */
export function findUserByEmail(
  tx: AuditedTransaction,
  email: string,
): Promise<UserSummary | null> {
  return tx.user.findUnique({ where: { email: email.toLowerCase() }, select: SUMMARY });
}

/** Whether any user holds the ADMIN role, whatever their status. */
export async function adminExists(tx: AuditedTransaction): Promise<boolean> {
  return (await tx.user.count({ where: { roles: { has: 'ADMIN' } } })) > 0;
}

/** Creates an ACTIVE administrator with no password; they set one through a RESET link. */
export function createAdminUser(
  tx: AuditedTransaction,
  admin: { email: string; name: string },
): Promise<UserSummary> {
  return tx.user.create({
    data: {
      id: uuidv7(),
      email: admin.email.toLowerCase(),
      name: admin.name,
      roles: ['ADMIN'],
      status: 'ACTIVE',
    },
    select: SUMMARY,
  });
}
