import { randomBytes } from 'node:crypto';
import {
  AppError,
  PUBLIC_REVOKE_REASONS,
  USER_STATUS,
  type Me,
  type PublicRevokeReason,
  type UserRole,
} from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import {
  withDatabase,
  type AuditedTransaction,
  type TransactionRunner,
} from '../db/transaction.js';
import type { Clock } from '../lib/clock.js';
import type { RequestContext } from '../lib/request-context.js';
import { SECOND_MS } from '../lib/time.js';
import { uuidv7 } from '../lib/uuid.js';
import { logSecurityEvent } from '../observability/security-log.js';
import type { RateLimiter } from '../rate-limit/service.js';
import { hashToken } from '../tokens/one-time.js';
import { toMe } from '../users/me.js';
import {
  findAuthUser,
  findLoginUser,
  recordFailedLogin,
  recordSuccessfulLogin,
} from '../users/repository.js';
import type { AccessTokens } from './access-token.js';
import {
  LOCKOUT_DURATION_SECONDS,
  type LoginFailureReason,
  LOCKOUT_THRESHOLD,
  REFRESH_SIBLING_GRACE_SECONDS,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_IDLE_SECONDS,
  SESSION_ABSOLUTE_LIFETIME_SECONDS,
} from './constants.js';
import type { SessionCookies } from './cookies.js';
import { csrfTokenFor } from './csrf.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';
import {
  findSessionIdByRefreshToken,
  insertRefreshToken,
  insertSession,
  lockRefreshToken,
  markRotated,
  revokeSession,
  revokeUserSessions,
  touchSession,
  type LockedRefreshToken,
} from './repository.js';

// Who is calling (ADR-0017, research R1). The authorize step calls these; it never touches
// a repository itself.

export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
  roles: readonly UserRole[];
}

export interface RefreshSession {
  sessionId: string;
  /** The presented refresh token, for the refresh, logout or logout-all handler. */
  refreshToken: string;
}

export interface AuthService {
  /**
   * The user behind an access token. No token or a bad one → 401 UNAUTHENTICATED; an
   * expired one → 401 ACCESS_TOKEN_EXPIRED; a deactivated user → 401 ACCOUNT_DEACTIVATED.
   */
  authenticate(accessToken: string | undefined): Promise<AuthenticatedUser>;
  /**
   * The session a refresh token belongs to, so the CSRF header can be checked against it.
   * No token → 401 UNAUTHENTICATED; an unknown one → 401 SESSION_EXPIRED (a purged session
   * looks the same). Whether the session may still be used is the handler's decision.
   */
  identifyRefreshSession(refreshToken: string | undefined): Promise<RefreshSession>;
}

export function createAuthService(deps: {
  prisma: AppPrismaClient;
  accessTokens: AccessTokens;
}): AuthService {
  return {
    authenticate: async (accessToken) => {
      if (!accessToken) throw new AppError('UNAUTHENTICATED');
      const check = await deps.accessTokens.verify(accessToken);
      if (!check.ok) throw new AppError(check.code);
      const user = await withDatabase(() => findAuthUser(deps.prisma, check.userId));
      if (!user) throw new AppError('UNAUTHENTICATED');
      if (user.status === USER_STATUS.DEACTIVATED) throw new AppError('ACCOUNT_DEACTIVATED');
      // Only verified users ever get a session; anything else is not a usable login.
      if (user.status !== USER_STATUS.ACTIVE) throw new AppError('UNAUTHENTICATED');
      return {
        userId: user.id,
        sessionId: check.sessionId,
        name: user.name,
        email: user.email,
        roles: user.roles,
      };
    },

    identifyRefreshSession: async (refreshToken) => {
      if (!refreshToken) throw new AppError('UNAUTHENTICATED');
      const sessionId = await withDatabase(() =>
        findSessionIdByRefreshToken(deps.prisma, hashToken(refreshToken)),
      );
      if (!sessionId) throw new AppError('SESSION_EXPIRED');
      return { sessionId, refreshToken };
    },
  };
}

// --- Sessions: login, refresh, logout (ADR-0017, research R5, R6, R9) ---------------------

export interface LoginInput {
  email: string;
  password: string;
}

export interface SessionService {
  /** Logs in: the user, and the cookies to set. Errors in ADR-0017's order. */
  login(input: LoginInput, ctx: RequestContext): Promise<{ user: Me; cookies: SessionCookies }>;
  /** Rotates the refresh token; the cookies to set. */
  refresh(session: RefreshSession, ctx: RequestContext): Promise<SessionCookies>;
  /** Revokes this session. */
  logout(session: RefreshSession, ctx: RequestContext): Promise<void>;
  /** Revokes every session of the session's user. */
  logoutAll(session: RefreshSession, ctx: RequestContext): Promise<void>;
}

export interface SessionServiceDependencies {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
  accessTokens: AccessTokens;
  rateLimiter: RateLimiter;
  clock: Clock;
  /** CSRF_SECRET, for the CSRF cookie bound to each session. */
  csrfSecret: string;
}

const SYSTEM = { type: 'SYSTEM' } as const;

function plus(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * SECOND_MS);
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/** Whole seconds from now until a time, never less than one. */
function secondsUntil(time: Date, now: Date): number {
  return Math.max(1, Math.ceil((time.getTime() - now.getTime()) / SECOND_MS));
}

/** A new refresh token's expiry: 7 days on, never past the session's absolute end. */
function refreshTokenExpiry(now: Date, absoluteExpiresAt: Date): Date {
  return earlier(plus(now, REFRESH_TOKEN_IDLE_SECONDS), absoluteExpiresAt);
}

function isPublicRevokeReason(reason: string | null): reason is PublicRevokeReason {
  return (PUBLIC_REVOKE_REASONS as readonly (string | null)[]).includes(reason);
}

/** SESSION_REVOKED, naming the reason only when the user may be told it. */
function sessionRevoked(reason: string | null): AppError {
  return isPublicRevokeReason(reason)
    ? new AppError('SESSION_REVOKED', { reason })
    : new AppError('SESSION_REVOKED');
}

/** Why a session can't be used now, or undefined. Deactivation is checked first. */
function unusable(token: LockedRefreshToken, now: Date): AppError | undefined {
  if (token.userStatus !== USER_STATUS.ACTIVE) return new AppError('ACCOUNT_DEACTIVATED');
  if (token.revokedAt) return sessionRevoked(token.revokeReason);
  if (token.tokenExpiresAt <= now || token.absoluteExpiresAt <= now) {
    return new AppError('SESSION_EXPIRED');
  }
  return undefined;
}

type RefreshOutcome =
  | { ok: true; userId: string; sessionId: string; refreshToken: string; expiresAt: Date }
  | { ok: false; error: AppError; reuse?: { sessionId: string; userId: string } };

export function createSessionService(deps: SessionServiceDependencies): SessionService {
  const { transactions, clock } = deps;

  async function cookiesFor(session: {
    userId: string;
    sessionId: string;
    refreshToken: string;
    expiresAt: Date;
    now: Date;
  }): Promise<SessionCookies> {
    return {
      accessToken: await deps.accessTokens.sign(session),
      refreshToken: session.refreshToken,
      csrfToken: csrfTokenFor(deps.csrfSecret, session.sessionId),
      refreshMaxAgeSeconds: Math.floor(
        (session.expiresAt.getTime() - session.now.getTime()) / SECOND_MS,
      ),
    };
  }

  /** A new refresh token for a session, at most 7 days and never past its absolute end. */
  async function issueRefreshToken(
    tx: AuditedTransaction,
    session: { id: string; absoluteExpiresAt: Date },
    now: Date,
  ) {
    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const expiresAt = refreshTokenExpiry(now, session.absoluteExpiresAt);
    await insertRefreshToken(tx, {
      id: uuidv7(now.getTime()),
      sessionId: session.id,
      tokenHash: hashToken(refreshToken),
      expiresAt,
      now,
    });
    return { refreshToken, expiresAt };
  }

  /** The refresh token locked, or 401 SESSION_EXPIRED when it is unknown or purged. */
  async function locked(tx: AuditedTransaction, session: RefreshSession) {
    const token = await lockRefreshToken(tx, hashToken(session.refreshToken));
    if (!token) throw new AppError('SESSION_EXPIRED');
    return token;
  }

  return {
    login: async (input, ctx) => {
      const email = input.email.toLowerCase();
      const event = { ip: ctx.ip, userAgent: ctx.userAgent };
      // Counted before any lookup, so unknown emails count too (research R8).
      await deps.rateLimiter.hit('login-ip', ctx.ip);
      await deps.rateLimiter.hit('login-account', email);

      const user = await withDatabase(() => findLoginUser(deps.prisma, email));
      const failed = (reason: LoginFailureReason, userId?: string) => {
        logSecurityEvent(ctx.logger, 'login_failed', { ...event, userId, reason });
      };
      if (!user) {
        failed('unknown_email');
        throw new AppError('ACCOUNT_NOT_FOUND');
      }
      const now = clock.now();
      if (user.lockedUntil && user.lockedUntil > now) {
        failed('locked', user.id);
        throw new AppError('ACCOUNT_LOCKED', {
          retryAfterSeconds: secondsUntil(user.lockedUntil, now),
        });
      }
      if (!user.passwordHash) {
        failed('password_not_set', user.id);
        throw new AppError('PASSWORD_NOT_SET');
      }
      if (!(await verifyPassword(user.passwordHash, input.password))) {
        const outcome = await transactions.run(
          { actor: SYSTEM, requestId: ctx.requestId, logger: ctx.logger },
          (tx) =>
            recordFailedLogin(tx, {
              id: user.id,
              threshold: LOCKOUT_THRESHOLD,
              now,
              lockUntil: plus(now, LOCKOUT_DURATION_SECONDS),
            }),
        );
        if (outcome.locked) {
          logSecurityEvent(ctx.logger, 'account_locked', { ...event, userId: user.id });
          throw new AppError('ACCOUNT_LOCKED', {
            retryAfterSeconds: secondsUntil(outcome.lockedUntil, now),
          });
        }
        failed('wrong_password', user.id);
        throw new AppError('INCORRECT_PASSWORD');
      }
      if (user.status === USER_STATUS.UNVERIFIED) {
        failed('unverified', user.id);
        throw new AppError('ACCOUNT_NOT_VERIFIED');
      }
      if (user.status !== USER_STATUS.ACTIVE) {
        failed('deactivated', user.id);
        throw new AppError('ACCOUNT_DEACTIVATED');
      }

      const upgradedHash = needsRehash(user.passwordHash)
        ? await hashPassword(input.password)
        : undefined;
      const session = {
        id: uuidv7(now.getTime()),
        absoluteExpiresAt: plus(now, SESSION_ABSOLUTE_LIFETIME_SECONDS),
      };
      const issued = await transactions.run(
        { actor: SYSTEM, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          const recorded = await recordSuccessfulLogin(tx, { id: user.id, now, upgradedHash });
          if (!recorded.ok) return recorded;
          await insertSession(
            tx,
            { ...session, userId: user.id, now, userAgent: ctx.userAgent, ip: ctx.ip },
            refreshTokenExpiry(now, session.absoluteExpiresAt),
          );
          return { ok: true as const, ...(await issueRefreshToken(tx, session, now)) };
        },
      );
      if (!issued.ok) {
        // Concurrent wrong guesses locked the account while this password was checked.
        failed('locked', user.id);
        throw new AppError('ACCOUNT_LOCKED', {
          retryAfterSeconds: secondsUntil(issued.lockedUntil, now),
        });
      }
      logSecurityEvent(ctx.logger, 'login_succeeded', {
        ...event,
        userId: user.id,
        sessionId: session.id,
      });
      return {
        user: toMe(user),
        cookies: await cookiesFor({
          userId: user.id,
          sessionId: session.id,
          now,
          refreshToken: issued.refreshToken,
          expiresAt: issued.expiresAt,
        }),
      };
    },

    refresh: async (session, ctx) => {
      const now = clock.now();
      const outcome = await transactions.run<RefreshOutcome>(
        { actor: SYSTEM, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          const token = await locked(tx, session);
          const refused = unusable(token, now);
          if (refused) return { ok: false, error: refused };
          if (token.rotatedAt) {
            const sinceRotation = now.getTime() - token.rotatedAt.getTime();
            if (sinceRotation > REFRESH_SIBLING_GRACE_SECONDS * SECOND_MS) {
              // Reuse of an old token: someone else may hold the newer one. The session ends,
              // and that must commit before the 401 is sent.
              await revokeSession(tx, { id: token.sessionId, reason: 'REUSE_DETECTED', now });
              return {
                ok: false,
                error: new AppError('SESSION_REVOKED'),
                reuse: { sessionId: token.sessionId, userId: token.userId },
              };
            }
          } else {
            await markRotated(tx, token.tokenId, now);
          }
          const issued = await issueRefreshToken(
            tx,
            { id: token.sessionId, absoluteExpiresAt: token.absoluteExpiresAt },
            now,
          );
          await touchSession(tx, { id: token.sessionId, now, tokenExpiresAt: issued.expiresAt });
          return { ok: true, userId: token.userId, sessionId: token.sessionId, ...issued };
        },
      );
      if (!outcome.ok) {
        if (outcome.reuse) {
          const fields = { ...outcome.reuse, ip: ctx.ip, userAgent: ctx.userAgent };
          logSecurityEvent(ctx.logger, 'refresh_reuse_detected', fields);
          logSecurityEvent(ctx.logger, 'session_revoked', {
            ...fields,
            by: 'SYSTEM',
            reason: 'REUSE_DETECTED',
          });
        }
        throw outcome.error;
      }
      return cookiesFor({ ...outcome, now });
    },

    logout: async (session, ctx) => {
      const now = clock.now();
      const userId = await transactions.run(
        { actor: SYSTEM, requestId: ctx.requestId, logger: ctx.logger },
        // Logging out always succeeds for a known token, whatever the session's state:
        // the cookies are cleared either way, and a revoked session keeps its first reason.
        async (tx) => {
          const token = await locked(tx, session);
          await revokeSession(tx, { id: token.sessionId, reason: 'LOGOUT', now });
          return token.userId;
        },
      );
      logSecurityEvent(ctx.logger, 'logout', {
        userId,
        sessionId: session.sessionId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },

    logoutAll: async (session, ctx) => {
      const now = clock.now();
      const userId = await transactions.run(
        { actor: SYSTEM, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          const token = await locked(tx, session);
          await revokeUserSessions(tx, { id: token.userId, reason: 'LOGOUT_ALL', now });
          return token.userId;
        },
      );
      logSecurityEvent(ctx.logger, 'logout_all', {
        userId,
        sessionId: session.sessionId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },
  };
}
