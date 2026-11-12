import { AppError, USER_STATUS, type Me, type OwnAccessRequest } from '@po/contracts';
import {
  findLatestAccessRequest,
  openOrUpdateAccessRequest,
  type AccessRequest,
} from '../access-requests/repository.js';
import type { AuthenticatedUser } from '../auth/service.js';
import { writeAudit } from '../audit/write.js';
import type { AppPrismaClient } from '../db/client.js';
import { withDatabase, type TransactionRunner } from '../db/transaction.js';
import type { RequestContext } from '../lib/request-context.js';
import type { RateLimiter } from '../rate-limit/service.js';
import { toMe } from '../users/me.js';
import { selfActor } from '../users/actor.js';
import { findProfile, lockUser, updateUserName } from '../users/repository.js';

// The caller's own profile and access request (ADR-0016). Slice 1 US4 adds the edit.

export interface ProfileService {
  getMe(userId: string): Promise<Me>;
  /** Sets the caller's name; the same name writes nothing. */
  updateMe(user: AuthenticatedUser, name: string, ctx: RequestContext): Promise<Me>;
  /** The caller's latest access request; 404 NOT_FOUND if they never sent one. */
  getOwnAccessRequest(userId: string): Promise<OwnAccessRequest>;
  /** Opens an access request, or updates the open one's message. */
  sendAccessRequest(
    user: AuthenticatedUser,
    message: string,
    ctx: RequestContext,
  ): Promise<OwnAccessRequest>;
}

function toOwnAccessRequest(request: AccessRequest): OwnAccessRequest {
  return {
    status: request.status,
    message: request.message,
    updatedAt: request.updatedAt.toISOString(),
    adminNote: request.adminNote,
  };
}

export function createProfileService(deps: {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
  rateLimiter: RateLimiter;
}): ProfileService {
  return {
    getMe: async (userId) => {
      const user = await withDatabase(() => findProfile(deps.prisma, userId));
      // The authorize step has just read this user, and users are never deleted.
      if (!user) throw new Error(`authenticated user ${userId} not found`);
      return toMe(user);
    },

    updateMe: async (user, name, ctx) => {
      const saved = await deps.transactions.run(
        {
          actor: selfActor({ id: user.userId, name: user.name, email: user.email }),
          requestId: ctx.requestId,
          logger: ctx.logger,
        },
        async (tx) => {
          // Locked, so the name audited as "before" is the one this edit replaces.
          const current = await lockUser(tx, user.userId);
          if (!current) throw new Error(`authenticated user ${user.userId} not found`);
          if (current.name === name) return current;
          const updated = await updateUserName(tx, user.userId, name);
          await writeAudit(tx, {
            action: 'USER_PROFILE_UPDATED',
            entityType: 'user',
            entityId: user.userId,
            details: { before: current.name, after: updated.name },
          });
          return updated;
        },
      );
      return toMe(saved);
    },

    getOwnAccessRequest: async (userId) => {
      const request = await withDatabase(() => findLatestAccessRequest(deps.prisma, userId));
      if (!request) throw new AppError('NOT_FOUND');
      return toOwnAccessRequest(request);
    },

    sendAccessRequest: async (user, message, ctx) => {
      await deps.rateLimiter.hit('access-request-user', user.userId);
      const request = await deps.transactions.run(
        {
          actor: selfActor({ id: user.userId, name: user.name, email: user.email }),
          requestId: ctx.requestId,
          logger: ctx.logger,
        },
        async (tx) => {
          // One send at a time per user, so two can't both open a request; and the user is
          // checked again under the lock, since an admin may have granted a role or
          // deactivated them since the authorize step read the user. Deactivation is said
          // as such, as the authorize step would on the next request.
          const locked = await lockUser(tx, user.userId);
          if (!locked) throw new Error(`authenticated user ${user.userId} not found`);
          if (locked.status !== USER_STATUS.ACTIVE) throw new AppError('ACCOUNT_DEACTIVATED');
          if (locked.roles.length > 0) throw new AppError('FORBIDDEN');
          const saved = await openOrUpdateAccessRequest(tx, { userId: user.userId, message });
          await writeAudit(tx, {
            action: 'ACCESS_REQUESTED',
            entityType: 'access_request',
            entityId: saved.id,
            details: { requestId: saved.id, message: saved.message },
          });
          return saved;
        },
      );
      return toOwnAccessRequest(request);
    },
  };
}
