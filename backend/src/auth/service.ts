import { AppError, isUserRole, USER_STATUS, type UserRole } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import { withDatabase } from '../db/transaction.js';
import { hashToken } from '../tokens/one-time.js';
import { findAuthUser } from '../users/repository.js';
import type { AccessTokens } from './access-token.js';
import { findSessionIdByRefreshToken } from './repository.js';

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

/** A stored role the code doesn't know means the code and the database disagree. */
function rolesOf(user: { id: string; roles: string[] }): UserRole[] {
  const unknown = user.roles.filter((role) => !isUserRole(role));
  if (unknown.length > 0) {
    throw new Error(`User ${user.id} holds roles the code doesn't know: ${unknown.join(', ')}`);
  }
  return user.roles.filter(isUserRole);
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
        roles: rolesOf(user),
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
