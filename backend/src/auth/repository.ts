import type { AppPrismaClient } from '../db/client.js';
import type { AuditedTransaction } from '../db/transaction.js';
import type { UserStatus } from '@po/contracts';
import { userRolesOf, userStatusOf } from '../users/codes.js';
import type { AuthUser } from '../users/repository.js';
import { SESSION_REVOKE_REASONS, type SessionRevokeReason } from './constants.js';

// Sessions and refresh tokens (migration 0008_sessions, research R5 and R6). Times come
// from the API's clock, passed in, so lifetimes are testable.

/**
 * The session a refresh token belongs to, whatever the token's or session's state, or
 * null when no token has this hash. Only the hash is ever looked up or stored.
 */
export async function findSessionIdByRefreshToken(
  prisma: AppPrismaClient,
  tokenHash: Buffer,
): Promise<string | null> {
  const token = await prisma.refreshToken.findUnique({
    where: { tokenHash: new Uint8Array(tokenHash) },
    select: { sessionId: true },
  });
  return token?.sessionId ?? null;
}

export interface NewSession {
  id: string;
  userId: string;
  now: Date;
  absoluteExpiresAt: Date;
  userAgent: string;
  ip: string;
}

export interface NewRefreshToken {
  id: string;
  sessionId: string;
  tokenHash: Buffer;
  expiresAt: Date;
  now: Date;
}

/** Opens a session; its expiry starts as its first refresh token's. */
export async function insertSession(
  tx: AuditedTransaction,
  session: NewSession,
  firstTokenExpiresAt: Date,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO sessions (id, user_id, created_at, last_used_at, absolute_expires_at,
                          expires_at, user_agent, ip)
    VALUES (${session.id}::uuid, ${session.userId}::uuid, ${session.now}, ${session.now},
            ${session.absoluteExpiresAt}, ${firstTokenExpiresAt}, ${session.userAgent},
            ${session.ip}::inet)`;
}

export async function insertRefreshToken(
  tx: AuditedTransaction,
  token: NewRefreshToken,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at, created_at)
    VALUES (${token.id}::uuid, ${token.sessionId}::uuid, ${token.tokenHash},
            ${token.expiresAt}, ${token.now})`;
}

/** A stored revoke reason, parsed: the CHECK allows only SESSION_REVOKE_REASONS. */
function revokeReasonOf(value: string | null): SessionRevokeReason | null {
  if (value === null) return null;
  const reason = SESSION_REVOKE_REASONS.find((known) => known === value);
  if (!reason) throw new Error(`session revoke reason the code doesn't know: ${value}`);
  return reason;
}

/** A refresh token with its session and its user's status, as the refresh decides on. */
export interface LockedRefreshToken {
  tokenId: string;
  rotatedAt: Date | null;
  tokenExpiresAt: Date;
  sessionId: string;
  userId: string;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokeReason: SessionRevokeReason | null;
  userStatus: UserStatus;
}

/**
 * Locks a refresh token and its session (research R5), so concurrent refreshes of one
 * token queue: the second sees the first's rotation. Null when no token has this hash.
 */
export async function lockRefreshToken(
  tx: AuditedTransaction,
  tokenHash: Buffer,
): Promise<LockedRefreshToken | null> {
  const [row] = await tx.$queryRaw<
    {
      token_id: string;
      rotated_at: Date | null;
      token_expires_at: Date;
      session_id: string;
      user_id: string;
      absolute_expires_at: Date;
      revoked_at: Date | null;
      revoke_reason: string | null;
      user_status: string;
    }[]
  >`
    SELECT t.id::text AS token_id, t.rotated_at, t.expires_at AS token_expires_at,
           s.id::text AS session_id, s.user_id::text AS user_id, s.absolute_expires_at,
           s.revoked_at, s.revoke_reason, u.status AS user_status
      FROM refresh_tokens t
      JOIN sessions s ON s.id = t.session_id
      JOIN users u ON u.id = s.user_id
     WHERE t.token_hash = ${tokenHash}
       FOR UPDATE OF t, s`;
  if (!row) return null;
  return {
    tokenId: row.token_id,
    rotatedAt: row.rotated_at,
    tokenExpiresAt: row.token_expires_at,
    sessionId: row.session_id,
    userId: row.user_id,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
    revokeReason: revokeReasonOf(row.revoke_reason),
    userStatus: userStatusOf({ id: row.user_id, status: row.user_status }),
  };
}

/** Marks a refresh token rotated, once; a sibling never moves the first rotation time. */
export async function markRotated(tx: AuditedTransaction, tokenId: string, now: Date) {
  await tx.$executeRaw`
    UPDATE refresh_tokens SET rotated_at = ${now}
     WHERE id = ${tokenId}::uuid AND rotated_at IS NULL`;
}

/** A refresh used the session: it was last used now, and lives at least as long as the new token. */
export async function touchSession(
  tx: AuditedTransaction,
  session: { id: string; now: Date; tokenExpiresAt: Date },
) {
  await tx.$executeRaw`
    UPDATE sessions SET last_used_at = ${session.now},
                        expires_at = GREATEST(expires_at, ${session.tokenExpiresAt})
     WHERE id = ${session.id}::uuid`;
}

/** Revokes one session, unless it already is (the first reason stays). */
export async function revokeSession(
  tx: AuditedTransaction,
  session: { id: string; reason: SessionRevokeReason; now: Date },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE sessions SET revoked_at = ${session.now}, revoke_reason = ${session.reason}
     WHERE id = ${session.id}::uuid AND revoked_at IS NULL`;
}

/** Revokes every live session of a user; returns how many it revoked. */
export async function revokeUserSessions(
  tx: AuditedTransaction,
  user: { id: string; reason: SessionRevokeReason; now: Date },
): Promise<number> {
  return tx.$executeRaw`
    UPDATE sessions SET revoked_at = ${user.now}, revoke_reason = ${user.reason}
     WHERE user_id = ${user.id}::uuid AND revoked_at IS NULL`;
}

/** An access token's session and user, as every authenticated request checks them. */
export interface AuthSession {
  user: AuthUser;
  revokedAt: Date | null;
  revokeReason: SessionRevokeReason | null;
  /** When the session ends: its latest refresh token's expiry or its absolute end. */
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * The session an access token names, with its user, in one indexed lookup (the session's
 * primary key): revocation, deactivation and role changes all apply on the next request
 * (ADR-0017, amended 2026-11-03). Null when no such session belongs to the user.
 */
export async function findAuthSession(
  prisma: AppPrismaClient,
  token: { sessionId: string; userId: string },
): Promise<AuthSession | null> {
  const [row] = await prisma.$queryRaw<
    {
      user_id: string;
      name: string;
      email: string;
      roles: string[];
      status: string;
      revoked_at: Date | null;
      revoke_reason: string | null;
      expires_at: Date;
      absolute_expires_at: Date;
    }[]
  >`
    SELECT u.id::text AS user_id, u.name, u.email, u.roles, u.status,
           s.revoked_at, s.revoke_reason, s.expires_at, s.absolute_expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ${token.sessionId}::uuid AND s.user_id = ${token.userId}::uuid`;
  if (!row) return null;
  const user = { id: row.user_id, roles: row.roles, status: row.status };
  return {
    user: {
      id: row.user_id,
      name: row.name,
      email: row.email,
      roles: userRolesOf(user),
      status: userStatusOf(user),
    },
    revokedAt: row.revoked_at,
    revokeReason: revokeReasonOf(row.revoke_reason),
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

/** Revokes every live session of a user but one (the caller's); returns how many. */
export async function revokeOtherUserSessions(
  tx: AuditedTransaction,
  user: { id: string; keepSessionId: string; reason: SessionRevokeReason; now: Date },
): Promise<number> {
  return tx.$executeRaw`
    UPDATE sessions SET revoked_at = ${user.now}, revoke_reason = ${user.reason}
     WHERE user_id = ${user.id}::uuid AND revoked_at IS NULL
       AND id <> ${user.keepSessionId}::uuid`;
}

/** A session as its user's list shows it. */
export interface LiveSession {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  userAgent: string;
  ip: string;
}

/** Not revoked, and within both its idle and its absolute expiry. */
function liveSessionsOf(userId: string, now: Date) {
  return {
    userId,
    revokedAt: null,
    expiresAt: { gt: now },
    absoluteExpiresAt: { gt: now },
  } as const;
}

/** A page of a user's live sessions, most recently used first, and how many there are. */
export async function listLiveSessions(
  prisma: AppPrismaClient,
  filter: { userId: string; now: Date; offset: number; limit: number },
): Promise<{ sessions: LiveSession[]; total: number }> {
  const where = liveSessionsOf(filter.userId, filter.now);
  const [sessions, total] = await Promise.all([
    prisma.session.findMany({
      where,
      orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
      skip: filter.offset,
      take: filter.limit,
      select: { id: true, createdAt: true, lastUsedAt: true, userAgent: true, ip: true },
    }),
    prisma.session.count({ where }),
  ]);
  return { sessions, total };
}

/** Locks one of a user's live sessions; false if it isn't theirs or has ended. */
export async function lockLiveSession(
  tx: AuditedTransaction,
  session: { id: string; userId: string; now: Date },
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM sessions
     WHERE id = ${session.id}::uuid AND user_id = ${session.userId}::uuid
       AND revoked_at IS NULL AND expires_at > ${session.now}
       AND absolute_expires_at > ${session.now}
       FOR UPDATE`;
  return rows.length === 1;
}
