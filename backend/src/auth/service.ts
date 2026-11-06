import { randomBytes } from 'node:crypto';
import {
  AppError,
  PUBLIC_REVOKE_REASONS,
  USER_STATUS,
  type ChangePasswordBody,
  type Me,
  type Page,
  type PageQuery,
  type PublicRevokeReason,
  type SessionItem,
  type UserRole,
  type UserStatus,
} from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import {
  withDatabase,
  type AuditedTransaction,
  type TransactionRunner,
} from '../db/transaction.js';
import type { Clock } from '../lib/clock.js';
import type { RequestContext } from '../lib/request-context.js';
import { plus, SECOND_MS } from '../lib/time.js';
import { uuidv7 } from '../lib/uuid.js';
import { logSecurityEvent } from '../observability/security-log.js';
import type { RateLimiter } from '../rate-limit/service.js';
import { hashToken } from '../tokens/one-time.js';
import { toMe } from '../users/me.js';
import { findLoginUser, recordSuccessfulLogin, setChangedPassword } from '../users/repository.js';
import type { AccessTokens } from './access-token.js';
import {
  type LoginFailureReason,
  REFRESH_SIBLING_GRACE_SECONDS,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_IDLE_SECONDS,
  SESSION_ABSOLUTE_LIFETIME_SECONDS,
  type SessionRevokeReason,
} from './constants.js';
import type { SessionCookies } from './cookies.js';
import { csrfTokenFor } from './csrf.js';
import { countWrongPassword, lockedError } from './lockout.js';
import { commonPasswordError, hashPassword, needsRehash, verifyPassword } from './passwords.js';
import {
  findAuthSession,
  findSessionIdByRefreshToken,
  insertRefreshToken,
  insertSession,
  listLiveSessions,
  lockLiveSession,
  lockPasswordChange,
  lockRefreshToken,
  markRotated,
  revokeOtherUserSessions,
  revokeSession,
  revokeUserSessions,
  touchSession,
} from './repository.js';
import { SYSTEM_ACTOR } from '../users/actor.js';

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
  clock: Clock;
}): AuthService {
  return {
    authenticate: async (accessToken) => {
      if (!accessToken) throw new AppError('UNAUTHENTICATED');
      const check = await deps.accessTokens.verify(accessToken);
      if (!check.ok) throw new AppError(check.code);
      const session = await withDatabase(() => findAuthSession(deps.prisma, check));
      // Purged, or not this user's: no login stands behind the token.
      if (!session) throw new AppError('UNAUTHENTICATED');
      const refused = refusal(
        {
          userStatus: session.user.status,
          revokedAt: session.revokedAt,
          revokeReason: session.revokeReason,
          endsAt: earlier(session.expiresAt, session.absoluteExpiresAt),
        },
        deps.clock.now(),
      );
      if (refused) throw refused;
      const { user } = session;
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
  /**
   * Changes the caller's password after checking the current one like login (lockout and
   * rate limits); every other session of theirs ends, the calling one stays.
   */
  changePassword(
    user: AuthenticatedUser,
    input: ChangePasswordBody,
    ctx: RequestContext,
  ): Promise<void>;
  /** The caller's live sessions, most recently used first. */
  listSessions(user: AuthenticatedUser, query: PageQuery): Promise<Page<SessionItem>>;
  /** Ends one of the caller's live sessions; `current` when it was the calling one. */
  revokeSession(
    user: AuthenticatedUser,
    sessionId: string,
    ctx: RequestContext,
  ): Promise<{ current: boolean }>;
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

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/** A new refresh token's expiry: 7 days on, never past the session's absolute end. */
function refreshTokenExpiry(now: Date, absoluteExpiresAt: Date): Date {
  return earlier(plus(now, REFRESH_TOKEN_IDLE_SECONDS), absoluteExpiresAt);
}

/** A change-password whose current password is wrong: a field error, not a 401 (ADR-0017). */
function wrongCurrentPassword(): AppError {
  return new AppError('VALIDATION_FAILED', {
    details: [{ path: 'body.currentPassword', code: 'INCORRECT_PASSWORD' }],
  });
}

function isPublicRevokeReason(reason: string | null): reason is PublicRevokeReason {
  return (PUBLIC_REVOKE_REASONS as readonly (string | null)[]).includes(reason);
}

/** SESSION_REVOKED, naming the reason only when the user may be told it. */
function sessionRevoked(reason: SessionRevokeReason | null): AppError {
  return isPublicRevokeReason(reason)
    ? new AppError('SESSION_REVOKED', { reason })
    : new AppError('SESSION_REVOKED');
}

interface SessionState {
  userStatus: UserStatus;
  revokedAt: Date | null;
  revokeReason: SessionRevokeReason | null;
  /** The earliest end: the token's or session's idle expiry, or the absolute end. */
  endsAt: Date;
}

/**
 * Why a session can't be used now, or undefined, in one order for every request and the
 * refresh (ADR-0017): deactivation, then revocation, then expiry.
 */
function refusal(state: SessionState, now: Date): AppError | undefined {
  if (state.userStatus !== USER_STATUS.ACTIVE) return new AppError('ACCOUNT_DEACTIVATED');
  if (state.revokedAt) return sessionRevoked(state.revokeReason);
  if (state.endsAt <= now) return new AppError('SESSION_EXPIRED');
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
      await deps.rateLimiter.hitAll([
        ['login-ip', ctx.ip],
        ['login-account', email],
      ]);

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
        throw lockedError(user.lockedUntil, now);
      }
      if (!user.passwordHash) {
        failed('password_not_set', user.id);
        throw new AppError('PASSWORD_NOT_SET');
      }
      if (!(await verifyPassword(user.passwordHash, input.password))) {
        const locked = await countWrongPassword(transactions, user.id, now, ctx);
        if (locked) throw locked;
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
        { actor: SYSTEM_ACTOR, requestId: ctx.requestId, logger: ctx.logger },
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
        throw lockedError(issued.lockedUntil, now);
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
        { actor: SYSTEM_ACTOR, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          const token = await locked(tx, session);
          const refused = refusal(
            {
              userStatus: token.userStatus,
              revokedAt: token.revokedAt,
              revokeReason: token.revokeReason,
              endsAt: earlier(token.tokenExpiresAt, token.absoluteExpiresAt),
            },
            now,
          );
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
        { actor: SYSTEM_ACTOR, requestId: ctx.requestId, logger: ctx.logger },
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
        { actor: SYSTEM_ACTOR, requestId: ctx.requestId, logger: ctx.logger },
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

    changePassword: async (user, input, ctx) => {
      const event = { userId: user.userId, ip: ctx.ip, userAgent: ctx.userAgent };
      // Rate-limited like login, in the same buckets (ADR-0017).
      await deps.rateLimiter.hitAll([
        ['login-ip', ctx.ip],
        ['login-account', user.email],
      ]);
      const common = commonPasswordError('body.newPassword', input.newPassword);
      if (common) throw new AppError('VALIDATION_FAILED', { details: [common] });

      const account = await withDatabase(() => findLoginUser(deps.prisma, user.email));
      // The authorize step has just read this user, and a logged-in user has a password.
      if (!account?.passwordHash)
        throw new Error(`password change for ${user.userId}: no password`);
      const now = clock.now();
      if (account.lockedUntil && account.lockedUntil > now) {
        logSecurityEvent(ctx.logger, 'password_change_failed', { ...event, reason: 'locked' });
        throw lockedError(account.lockedUntil, now);
      }
      if (!(await verifyPassword(account.passwordHash, input.currentPassword))) {
        const lockout = await countWrongPassword(transactions, account.id, now, ctx);
        if (lockout) throw lockout;
        logSecurityEvent(ctx.logger, 'password_change_failed', {
          ...event,
          reason: 'wrong_password',
        });
        throw wrongCurrentPassword();
      }
      // The verified current password, so a plain comparison needs no hash (ADR-0017).
      if (input.newPassword === input.currentPassword) {
        throw new AppError('VALIDATION_FAILED', {
          details: [{ path: 'body.newPassword', code: 'PASSWORD_UNCHANGED' }],
        });
      }

      const passwordHash = await hashPassword(input.newPassword);
      const outcome = await transactions.run(
        { actor: SYSTEM_ACTOR, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          // Checked again under the locks: a reset, a logout-all or another change may have
          // landed while the passwords were hashed (research R9).
          const state = await lockPasswordChange(tx, {
            userId: account.id,
            sessionId: user.sessionId,
          });
          if (!state) throw new Error(`password change from a session not ${account.id}'s`);
          const endsAt = earlier(state.expiresAt, state.absoluteExpiresAt);
          const refused = refusal({ ...state, endsAt }, now);
          if (refused) throw refused;
          if (state.passwordHash !== account.passwordHash) {
            // Changed meanwhile: the password this request proved is no longer the current one.
            throw wrongCurrentPassword();
          }
          const written = await setChangedPassword(tx, { id: account.id, passwordHash, now });
          if (!written.ok) return written;
          const revoked = await revokeOtherUserSessions(tx, {
            id: account.id,
            keepSessionId: user.sessionId,
            reason: 'PASSWORD_CHANGED',
            now,
          });
          return { ok: true as const, revoked };
        },
      );
      if (!outcome.ok) {
        // Concurrent wrong guesses locked the account while this password was checked.
        logSecurityEvent(ctx.logger, 'password_change_failed', { ...event, reason: 'locked' });
        throw lockedError(outcome.lockedUntil, now);
      }
      logSecurityEvent(ctx.logger, 'password_changed', { ...event, sessionId: user.sessionId });
      if (outcome.revoked > 0) {
        logSecurityEvent(ctx.logger, 'session_revoked', {
          userId: user.userId,
          reason: 'PASSWORD_CHANGED',
          by: 'USER',
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
    },

    listSessions: async (user, query) => {
      const { sessions, total } = await withDatabase(() =>
        listLiveSessions(deps.prisma, {
          userId: user.userId,
          now: clock.now(),
          offset: (query.page - 1) * query.pageSize,
          limit: query.pageSize,
        }),
      );
      return {
        items: sessions.map((session) => ({
          id: session.id,
          createdAt: session.createdAt.toISOString(),
          lastUsedAt: session.lastUsedAt.toISOString(),
          userAgent: session.userAgent,
          ip: session.ip,
          current: session.id === user.sessionId,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    },

    revokeSession: async (user, sessionId, ctx) => {
      const now = clock.now();
      await transactions.run(
        { actor: SYSTEM_ACTOR, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          // Someone else's session, or one that has ended, is not the caller's to see.
          if (!(await lockLiveSession(tx, { id: sessionId, userId: user.userId, now }))) {
            throw new AppError('NOT_FOUND');
          }
          await revokeSession(tx, { id: sessionId, reason: 'USER_REVOKED', now });
        },
      );
      logSecurityEvent(ctx.logger, 'session_revoked', {
        userId: user.userId,
        sessionId,
        reason: 'USER_REVOKED',
        by: 'USER',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { current: sessionId === user.sessionId };
    },
  };
}
