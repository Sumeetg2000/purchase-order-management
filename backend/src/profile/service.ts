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
import { findProfile, lockUser } from '../users/repository.js';

// The caller's own profile and access request (ADR-0016). Slice 1 US4 adds the edit.

export interface ProfileService {
  getMe(userId: string): Promise<Me>;
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
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
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
          // deactivated them since the authorize step read the user.
          const locked = await lockUser(tx, user.userId);
          if (!locked || locked.roles.length > 0 || locked.status !== USER_STATUS.ACTIVE) {
            throw new AppError('FORBIDDEN');
          }
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
