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

/** What login needs about a user, read outside any transaction. */
export interface LoginUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
  status: string;
  createdAt: Date;
  passwordHash: string | null;
  lockedUntil: Date | null;
}

export function findLoginUser(prisma: AppPrismaClient, email: string): Promise<LoginUser | null> {
  return prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      roles: true,
      status: true,
      createdAt: true,
      passwordHash: true,
      lockedUntil: true,
    },
  });
}

export type FailedLogin = { locked: true; lockedUntil: Date } | { locked: false };

/**
 * Counts a wrong password in one atomic statement (research R9): the attempt that
 * reaches the threshold resets the count and locks the account until `lockUntil`.
 * Concurrent attempts queue on the row, so none can skip the lock. An account another
 * attempt has just locked is reported locked, without counting.
 */
export async function recordFailedLogin(
  tx: AuditedTransaction,
  user: { id: string; threshold: number; now: Date; lockUntil: Date },
): Promise<FailedLogin> {
  const [row] = await tx.$queryRaw<{ locked_until: Date | null; just_locked: boolean }[]>`
    UPDATE users SET
      failed_login_count = CASE WHEN failed_login_count + 1 >= ${user.threshold}
                                THEN 0 ELSE failed_login_count + 1 END,
      locked_until = CASE WHEN failed_login_count + 1 >= ${user.threshold}
                          THEN ${user.lockUntil} ELSE locked_until END
     WHERE id = ${user.id}::uuid AND (locked_until IS NULL OR locked_until <= ${user.now})
    RETURNING locked_until, locked_until IS NOT DISTINCT FROM ${user.lockUntil}::timestamptz
              AS just_locked`;
  if (row) {
    return row.just_locked && row.locked_until
      ? { locked: true, lockedUntil: row.locked_until }
      : { locked: false };
  }
  const current = await tx.user.findUnique({
    where: { id: user.id },
    select: { lockedUntil: true },
  });
  return { locked: true, lockedUntil: current?.lockedUntil ?? user.lockUntil };
}

/** A successful login: the count resets and the time is kept; an old hash is upgraded. */
export async function recordSuccessfulLogin(
  tx: AuditedTransaction,
  user: { id: string; now: Date; upgradedHash?: string | undefined },
): Promise<void> {
  await tx.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: user.now,
      ...(user.upgradedHash === undefined ? {} : { passwordHash: user.upgradedHash }),
    },
    select: { id: true },
  });
}

/** The user's profile as the API shows it to them. */
export interface ProfileUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
  status: string;
  createdAt: Date;
}

const PROFILE = {
  id: true,
  name: true,
  email: true,
  roles: true,
  status: true,
  createdAt: true,
} as const;

export function findProfile(prisma: AppPrismaClient, id: string): Promise<ProfileUser | null> {
  return prisma.user.findUnique({ where: { id }, select: PROFILE });
}

/** Locks a user's row for a change and returns it, or null. */
export async function lockUser(tx: AuditedTransaction, id: string): Promise<ProfileUser | null> {
  await tx.$executeRaw`SELECT 1 FROM users WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.user.findUnique({ where: { id }, select: PROFILE });
}

/** A completed reset: the new password, and any lockout cleared. Version unchanged. */
export async function setPasswordAfterReset(
  tx: AuditedTransaction,
  id: string,
  passwordHash: string,
): Promise<void> {
  await tx.user.update({
    where: { id },
    data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    select: { id: true },
  });
}

/** UNVERIFIED → ACTIVE, bumping the version (ADR-0016). */
export async function activateUser(tx: AuditedTransaction, id: string): Promise<void> {
  await tx.user.update({
    where: { id },
    data: { status: USER_STATUS.ACTIVE, version: { increment: 1 } },
    select: { id: true },
  });
}
