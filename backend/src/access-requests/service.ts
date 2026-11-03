import {
  AppError,
  ACCESS_REQUEST_STATUS,
  type AccessRequestListQuery,
  type AdminAccessRequest,
  type Page,
} from '@po/contracts';
import type { AuthenticatedUser } from '../auth/service.js';
import { writeAudit } from '../audit/write.js';
import type { AppPrismaClient } from '../db/client.js';
import { withDatabase, type TransactionRunner } from '../db/transaction.js';
import type { Clock } from '../lib/clock.js';
import type { RequestContext } from '../lib/request-context.js';
import { adminActor } from '../users/actor.js';
import {
  dismissAccessRequest,
  listAccessRequests,
  lockAccessRequest,
  type AdminAccessRequestRow,
} from './repository.js';

// The admin's side of access requests (ADR-0016): the list and dismissal. Assigning a role
// resolves a request; that lives with the role change (admin-users/service.ts).

export interface AccessRequestsService {
  list(query: AccessRequestListQuery): Promise<Page<AdminAccessRequest>>;
  /** Dismisses an open request; a blank note is no note. */
  dismiss(
    admin: AuthenticatedUser,
    dismissal: { id: string; note: string | undefined },
    ctx: RequestContext,
  ): Promise<AdminAccessRequest>;
}

function toAdminAccessRequest(row: AdminAccessRequestRow): AdminAccessRequest {
  return {
    id: row.id,
    status: row.status,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    adminNote: row.adminNote,
    user: {
      id: row.user.id,
      name: row.user.name,
      email: row.user.email,
      signedUpAt: row.user.createdAt.toISOString(),
    },
  };
}

export function createAccessRequestsService(deps: {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
  clock: Clock;
}): AccessRequestsService {
  return {
    list: async (query) => {
      const { requests, total } = await withDatabase(() =>
        listAccessRequests(deps.prisma, {
          status: query.status,
          offset: (query.page - 1) * query.pageSize,
          limit: query.pageSize,
        }),
      );
      return {
        items: requests.map(toAdminAccessRequest),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    },

    dismiss: async (admin, { id, note }, ctx) => {
      const kept = note ? note : null;
      const dismissed = await deps.transactions.run(
        {
          actor: adminActor({ id: admin.userId, name: admin.name, email: admin.email }),
          requestId: ctx.requestId,
          logger: ctx.logger,
        },
        async (tx) => {
          const status = await lockAccessRequest(tx, id);
          if (!status) throw new AppError('NOT_FOUND');
          if (status !== ACCESS_REQUEST_STATUS.OPEN) throw new AppError('ACCESS_REQUEST_NOT_OPEN');
          const row = await dismissAccessRequest(tx, {
            id,
            decidedBy: admin.userId,
            note: kept,
            now: deps.clock.now(),
          });
          await writeAudit(tx, {
            action: 'ACCESS_REQUEST_DISMISSED',
            entityType: 'access_request',
            entityId: id,
            details: { requestId: id, note: kept },
          });
          return row;
        },
      );
      return toAdminAccessRequest(dismissed);
    },
  };
}
