import { ROLE, USER_STATUS, type UserRole, type UserStatus } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';
import { userRolesOf, userStatusOf } from './codes.js';

// Users (ADR-0016): the bootstrap and admin:create, login bookkeeping, the profile, and
// the admin screens. Emails arrive lower-cased (users_email_lower requires it); the
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
  roles: UserRole[];
  status: UserStatus;
}

/** A user row's codes, parsed (users/codes.ts). */
function parsed<T extends { id: string; roles: string[]; status: string }>(
  user: T,
): Omit<T, 'roles' | 'status'> & { roles: UserRole[]; status: UserStatus } {
  return { ...user, roles: userRolesOf(user), status: userStatusOf(user) };
}

/** What a password check needs about a user: login, change-password, verify-email. */
export interface LoginUser {
  id: string;
  name: string;
  email: string;
  roles: UserRole[];
  status: UserStatus;
  createdAt: Date;
  passwordHash: string | null;
  lockedUntil: Date | null;
}

const LOGIN = {
  id: true,
  name: true,
  email: true,
  roles: true,
  status: true,
  createdAt: true,
  passwordHash: true,
  lockedUntil: true,
} as const;

export async function findLoginUser(
  prisma: AppPrismaClient,
  email: string,
): Promise<LoginUser | null> {
  const user = await prisma.user.findUnique({ where: { email }, select: LOGIN });
  return user && parsed(user);
}

/** Locks a user's row and returns it with its password and lockout, or null. */
export async function lockLoginUser(tx: AuditedTransaction, id: string): Promise<LoginUser | null> {
  await tx.$executeRaw`SELECT 1 FROM users WHERE id = ${id}::uuid FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id }, select: LOGIN });
  return user && parsed(user);
}

/** `justLocked`: this attempt locked the account, not one before it. */
export type FailedLogin =
  { locked: true; lockedUntil: Date; justLocked: boolean } | { locked: false };

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
      ? { locked: true, lockedUntil: row.locked_until, justLocked: true }
      : { locked: false };
  }
  const current = await tx.user.findUnique({
    where: { id: user.id },
    select: { lockedUntil: true },
  });
  // Already locked by an attempt that ran alongside this one: that one reports the lock.
  return { locked: true, lockedUntil: current?.lockedUntil ?? user.lockUntil, justLocked: false };
}

export type SuccessfulLogin = { ok: true } | { ok: false; lockedUntil: Date };

/**
 * A successful login: the count resets, the time is kept and an old hash is upgraded.
 * The lock is checked again here, under the row lock the UPDATE takes: wrong guesses
 * running alongside this one may have locked the account while its password was checked,
 * and a correct guess must not clear that lock.
 */
export async function recordSuccessfulLogin(
  tx: AuditedTransaction,
  user: { id: string; now: Date; upgradedHash?: string | undefined },
): Promise<SuccessfulLogin> {
  const updated = await tx.$executeRaw`
    UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ${user.now},
                     password_hash = COALESCE(${user.upgradedHash ?? null}, password_hash)
     WHERE id = ${user.id}::uuid AND (locked_until IS NULL OR locked_until <= ${user.now})`;
  if (updated === 1) return { ok: true };
  const current = await tx.user.findUnique({
    where: { id: user.id },
    select: { lockedUntil: true },
  });
  if (!current?.lockedUntil) throw new Error(`login for a user that does not exist: ${user.id}`);
  return { ok: false, lockedUntil: current.lockedUntil };
}

/** The user's profile as the API shows it to them. */
export interface ProfileUser {
  id: string;
  name: string;
  email: string;
  roles: UserRole[];
  status: UserStatus;
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

export async function findProfile(
  prisma: AppPrismaClient,
  id: string,
): Promise<ProfileUser | null> {
  const user = await prisma.user.findUnique({ where: { id }, select: PROFILE });
  return user && parsed(user);
}

/** Locks a user's row for a change and returns it, or null. */
export async function lockUser(tx: AuditedTransaction, id: string): Promise<ProfileUser | null> {
  await tx.$executeRaw`SELECT 1 FROM users WHERE id = ${id}::uuid FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id }, select: PROFILE });
  return user && parsed(user);
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

/** A self-signup: UNVERIFIED, with no role (ADR-0017). */
export async function createSignupUser(
  tx: AuditedTransaction,
  user: { name: string; email: string; passwordHash: string },
): Promise<ProfileUser> {
  const created = await tx.user.create({
    data: {
      id: uuidv7(),
      name: user.name,
      email: user.email,
      passwordHash: user.passwordHash,
      roles: [],
      status: USER_STATUS.UNVERIFIED,
    },
    select: PROFILE,
  });
  return parsed(created);
}

/** A user as the admin screens show them (ADR-0016). */
export interface ManagedUser {
  id: string;
  name: string;
  email: string;
  roles: UserRole[];
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  version: number;
}

const MANAGED = {
  id: true,
  name: true,
  email: true,
  roles: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  version: true,
} as const;

export interface UserListFilter {
  role?: UserRole | 'NONE' | undefined;
  status?: UserStatus | undefined;
  /** A case-insensitive prefix of the name or email, matched literally. */
  q?: string | undefined;
  offset: number;
  limit: number;
}

/** LIKE's wildcards and its escape character, escaped so the text matches literally. */
function likePrefix(text: string): string {
  return `${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * A page of users sorted by name then id, and the number of matches. The prefix search
 * compares lower(name) and lower(email), which the text_pattern_ops indexes serve
 * (migration 0007_user_accounts).
 */
export async function listUsers(
  prisma: AppPrismaClient,
  filter: UserListFilter,
): Promise<{ users: ManagedUser[]; total: number }> {
  const conditions: Prisma.Sql[] = [];
  if (filter.role === 'NONE') conditions.push(Prisma.sql`roles = '{}'`);
  else if (filter.role) conditions.push(Prisma.sql`${filter.role} = ANY (roles)`);
  if (filter.status) conditions.push(Prisma.sql`status = ${filter.status}`);
  if (filter.q) {
    const pattern = likePrefix(filter.q);
    conditions.push(Prisma.sql`(lower(name) LIKE ${pattern} OR lower(email) LIKE ${pattern})`);
  }
  const where =
    conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  const [rows, [count]] = await Promise.all([
    prisma.$queryRaw<
      (Omit<ManagedUser, 'roles' | 'status'> & { roles: string[]; status: string })[]
    >`
      SELECT id, name, email, roles, status, last_login_at AS "lastLoginAt",
             created_at AS "createdAt", version
        FROM users ${where}
       ORDER BY name, id
       LIMIT ${filter.limit} OFFSET ${filter.offset}`,
    prisma.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM users ${where}`,
  ]);
  const users = rows.map(parsed);
  return { users, total: Number(count?.total ?? 0) };
}

export async function findManagedUser(
  prisma: AppPrismaClient,
  id: string,
): Promise<ManagedUser | null> {
  const user = await prisma.user.findUnique({ where: { id }, select: MANAGED });
  return user && parsed(user);
}

/** Locks a user's row for an admin change and returns it, or null. */
export async function lockManagedUser(
  tx: AuditedTransaction,
  id: string,
): Promise<ManagedUser | null> {
  await tx.$executeRaw`SELECT 1 FROM users WHERE id = ${id}::uuid FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id }, select: MANAGED });
  return user && parsed(user);
}

/** Locks the user with this (lower-cased) email for a status change and returns it, or null. */
export async function lockManagedUserByEmail(
  tx: AuditedTransaction,
  email: string,
): Promise<ManagedUser | null> {
  await tx.$executeRaw`SELECT 1 FROM users WHERE email = ${email} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { email }, select: MANAGED });
  return user && parsed(user);
}

/** The administrator test: the role set has ADMIN (users_roles_valid allows only {ADMIN}). */
export function isAdmin(roles: readonly UserRole[]): boolean {
  return roles.includes(ROLE.ADMIN);
}

/**
 * How many administrators are ACTIVE, by the same test as isAdmin (roles has ADMIN);
 * callers hold ADMIN_LOCK so the count stays true.
 */
export function countActiveAdmins(tx: AuditedTransaction): Promise<number> {
  return tx.user.count({ where: { roles: { has: ROLE.ADMIN }, status: USER_STATUS.ACTIVE } });
}

/**
 * An admin's change of role set or activation, under the row lock: one version bump,
 * and deactivated_at kept in step with the status (users_deactivated_at_matches_status):
 * set when the user is deactivated, cleared on reactivation, otherwise left as it is.
 */
export async function updateManagedUser(
  tx: AuditedTransaction,
  id: string,
  change: { roles: readonly UserRole[]; status: UserStatus; previousStatus: UserStatus; now: Date },
): Promise<ManagedUser> {
  const deactivatedAt =
    change.status !== USER_STATUS.DEACTIVATED
      ? null
      : change.previousStatus === USER_STATUS.DEACTIVATED
        ? undefined
        : change.now;
  const user = await tx.user.update({
    where: { id },
    data: {
      roles: [...change.roles],
      status: change.status,
      ...(deactivatedAt === undefined ? {} : { deactivatedAt }),
      version: { increment: 1 },
    },
    select: MANAGED,
  });
  return parsed(user);
}

/** Creates an ACTIVE user unless the email is taken; true if it was created. */
export async function insertUserIfAbsent(
  tx: AuditedTransaction,
  user: { name: string; email: string; roles: readonly UserRole[]; passwordHash: string },
): Promise<boolean> {
  const created = await tx.$executeRaw`
    INSERT INTO users (id, name, email, roles, status, password_hash)
    VALUES (${uuidv7()}::uuid, ${user.name}, ${user.email}, ${[...user.roles]}::text[],
            ${USER_STATUS.ACTIVE}, ${user.passwordHash})
    ON CONFLICT ON CONSTRAINT users_email_key DO NOTHING`;
  return created === 1;
}

/**
 * A changed password: the new hash, and the lockout cleared. The lock is checked again
 * under the row lock the UPDATE takes, as recordSuccessfulLogin does: wrong guesses
 * running alongside may have locked the account meanwhile. Version unchanged.
 */
export async function setChangedPassword(
  tx: AuditedTransaction,
  user: { id: string; passwordHash: string; now: Date },
): Promise<SuccessfulLogin> {
  const updated = await tx.$executeRaw`
    UPDATE users SET password_hash = ${user.passwordHash}, failed_login_count = 0,
                     locked_until = NULL
     WHERE id = ${user.id}::uuid AND (locked_until IS NULL OR locked_until <= ${user.now})`;
  if (updated === 1) return { ok: true };
  const current = await tx.user.findUnique({
    where: { id: user.id },
    select: { lockedUntil: true },
  });
  if (!current?.lockedUntil) throw new Error(`password change for a missing user: ${user.id}`);
  return { ok: false, lockedUntil: current.lockedUntil };
}

/** The user's own name edit (PATCH /me), bumping the version as every profile change does. */
export async function updateUserName(
  tx: AuditedTransaction,
  id: string,
  name: string,
): Promise<ProfileUser> {
  const user = await tx.user.update({
    where: { id },
    data: { name, version: { increment: 1 } },
    select: PROFILE,
  });
  return parsed(user);
}
