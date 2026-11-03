import { ROLE, USER_STATUS } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';

// The minimal user repository slice 0 needs for the bootstrap and admin:create. Slice 1
// adds the rest (ADR-0016). Emails arrive lower-cased (users_email_lower requires it); the
// callers normalise them once.

export interface UserSummary {
  id: string;
  email: string;
  roles: string[];
  status: string;
}

const SUMMARY = { id: true, email: true, roles: true, status: true } as const;

/** The user with this (lower-case) email, or null. */
export function findUserByEmail(
  tx: AuditedTransaction,
  email: string,
): Promise<UserSummary | null> {
  return tx.user.findUnique({ where: { email }, select: SUMMARY });
}

/** Whether any user holds the ADMIN role, whatever their status. Stops at the first. */
export async function adminExists(tx: AuditedTransaction): Promise<boolean> {
  const admin = await tx.user.findFirst({
    where: { roles: { has: ROLE.ADMIN } },
    select: { id: true },
  });
  return admin !== null;
}

/** Creates an ACTIVE administrator with no password; they set one through a RESET link. */
export function createAdminUser(
  tx: AuditedTransaction,
  admin: { email: string; name: string },
): Promise<UserSummary> {
  return tx.user.create({
    data: {
      id: uuidv7(),
      email: admin.email,
      name: admin.name,
      roles: [ROLE.ADMIN],
      status: USER_STATUS.ACTIVE,
    },
    select: SUMMARY,
  });
}

/** What every authenticated request needs about its user (research R1). */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
  status: string;
}

/**
 * The user behind an access token, read by primary key on every request, so a role
 * change or deactivation applies to the very next request. Runs outside a transaction.
 */
export function findAuthUser(prisma: AppPrismaClient, id: string): Promise<AuthUser | null> {
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, roles: true, status: true },
  });
}
