import {
  ACCESS_REQUEST_STATUS,
  AppError,
  assignableRoleSet,
  DEACTIVATION_DISMISSAL_NOTE,
  ROLE,
  USER_STATUS,
  type AdminUserDetail,
  type AdminUserItem,
  type Page,
  type UpdateUserBody,
  type UserListQuery,
  type UserRole,
} from '@po/contracts';
import { closeOpenAccessRequest } from '../access-requests/repository.js';
import type { SessionRevokeReason } from '../auth/constants.js';
import { revokeUserSessions } from '../auth/repository.js';
import type { AuthenticatedUser } from '../auth/service.js';
import { writeAudit } from '../audit/write.js';
import type { AppPrismaClient } from '../db/client.js';
import {
  withDatabase,
  type AuditedTransaction,
  type TransactionHooks,
  type TransactionRunner,
} from '../db/transaction.js';
import type { Clock } from '../lib/clock.js';
import type { RequestContext } from '../lib/request-context.js';
import type { MailDispatcher } from '../mail/dispatcher.js';
import { logSecurityEvent } from '../observability/security-log.js';
import { emailOneTimeLink } from '../tokens/email-link.js';
import { adminActor } from '../users/actor.js';
import {
  findManagedUser,
  listUsers,
  lockManagedUser,
  updateManagedUser,
  type ManagedUser,
} from '../users/repository.js';

// Admin user management (ADR-0016): the user list and detail, role and activation
// changes, and the admin-initiated reset email. Admins never set or see a password.

export interface AdminUsersService {
  listUsers(query: UserListQuery): Promise<Page<AdminUserItem>>;
  getUser(id: string): Promise<AdminUserDetail>;
  /** Applies a role or activation change at `version`; a no-op writes nothing. */
  updateUser(
    admin: AuthenticatedUser,
    target: { id: string; version: number; change: UpdateUserBody },
    ctx: RequestContext,
  ): Promise<AdminUserDetail>;
  /** Emails the user the standard reset link; their password keeps working until used. */
  sendPasswordReset(admin: AuthenticatedUser, id: string, ctx: RequestContext): Promise<void>;
}

export interface AdminUsersServiceDependencies {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
  mail: MailDispatcher;
  clock: Clock;
  /** APP_ORIGIN, for the link in the email. */
  appOrigin: string;
}

function toItem(user: ManagedUser): AdminUserItem {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

function toDetail(user: ManagedUser): AdminUserDetail {
  return {
    ...toItem(user),
    createdAt: user.createdAt.toISOString(),
    version: user.version,
  };
}

/** The assignable set the body named, in canonical order; the schema accepted only those. */
function canonicalRoles(roles: readonly UserRole[]): readonly UserRole[] {
  const set = assignableRoleSet(roles);
  if (!set) throw new Error(`updateUserBody let through an unassignable role set: ${roles.join()}`);
  return set;
}

function sameRoles(a: readonly UserRole[], b: readonly UserRole[]): boolean {
  return a.length === b.length && a.every((role) => b.includes(role));
}

/**
 * The guards every admin action on a user passes, in ADR-0016's order, after 404: not
 * the admin themself, and not another admin.
 */
function guardTarget(admin: AuthenticatedUser, target: ManagedUser | null): ManagedUser {
  if (!target) throw new AppError('NOT_FOUND');
  if (target.id === admin.userId) throw new AppError('SELF_MODIFICATION');
  if (target.roles.includes(ROLE.ADMIN)) throw new AppError('ADMIN_NOT_MODIFIABLE');
  return target;
}

export function createAdminUsersService(deps: AdminUsersServiceDependencies): AdminUsersService {
  function transaction<T>(
    admin: AuthenticatedUser,
    ctx: RequestContext,
    work: (tx: AuditedTransaction, hooks: TransactionHooks) => Promise<T>,
  ): Promise<T> {
    return deps.transactions.run(
      {
        actor: adminActor({ id: admin.userId, name: admin.name, email: admin.email }),
        requestId: ctx.requestId,
        logger: ctx.logger,
      },
      work,
    );
  }

  /** Closes the user's open access request to match the change, and audits it. */
  async function settleAccessRequest(
    tx: AuditedTransaction,
    admin: AuthenticatedUser,
    user: ManagedUser,
    now: Date,
  ) {
    if (user.status === USER_STATUS.DEACTIVATED) {
      const requestId = await closeOpenAccessRequest(tx, {
        userId: user.id,
        status: ACCESS_REQUEST_STATUS.DISMISSED,
        decidedBy: null,
        note: DEACTIVATION_DISMISSAL_NOTE,
        now,
      });
      if (requestId) {
        await writeAudit(tx, {
          action: 'ACCESS_REQUEST_DISMISSED',
          entityType: 'access_request',
          entityId: requestId,
          details: { requestId, note: DEACTIVATION_DISMISSAL_NOTE },
        });
      }
      return;
    }
    const requestId = await closeOpenAccessRequest(tx, {
      userId: user.id,
      status: ACCESS_REQUEST_STATUS.RESOLVED,
      decidedBy: admin.userId,
      note: null,
      now,
    });
    if (requestId) {
      await writeAudit(tx, {
        action: 'ACCESS_REQUEST_RESOLVED',
        entityType: 'access_request',
        entityId: requestId,
        details: { requestId, roles: user.roles },
      });
    }
  }

  return {
    listUsers: async (query) => {
      const { users, total } = await withDatabase(() =>
        listUsers(deps.prisma, {
          role: query.role,
          status: query.status,
          q: query.q,
          offset: (query.page - 1) * query.pageSize,
          limit: query.pageSize,
        }),
      );
      return { items: users.map(toItem), page: query.page, pageSize: query.pageSize, total };
    },

    getUser: async (id) => {
      const user = await withDatabase(() => findManagedUser(deps.prisma, id));
      if (!user) throw new AppError('NOT_FOUND');
      return toDetail(user);
    },

    updateUser: async (admin, { id, version, change }, ctx) => {
      const now = deps.clock.now();
      const result = await transaction(admin, ctx, async (tx) => {
        const target = guardTarget(admin, await lockManagedUser(tx, id));
        if (change.isActive !== undefined && target.status === USER_STATUS.UNVERIFIED) {
          // UNVERIFIED leaves only by proving the mailbox (ADR-0016's transitions).
          throw new AppError('USER_UNVERIFIED');
        }
        if (target.version !== version) throw new AppError('VERSION_CONFLICT');

        const roles = change.roles ? canonicalRoles(change.roles) : target.roles;
        const status =
          change.isActive === undefined
            ? target.status
            : change.isActive
              ? USER_STATUS.ACTIVE
              : USER_STATUS.DEACTIVATED;
        const rolesChanged = !sameRoles(roles, target.roles);
        const statusChanged = status !== target.status;
        if (!rolesChanged && !statusChanged) return { user: target, revoked: null };

        const updated = await updateManagedUser(tx, id, {
          roles,
          status,
          previousStatus: target.status,
          now,
        });
        const reason: SessionRevokeReason | null =
          statusChanged && status === USER_STATUS.DEACTIVATED
            ? 'DEACTIVATED'
            : rolesChanged
              ? 'ROLES_CHANGED'
              : null;
        const sessionsRevoked = reason ? await revokeUserSessions(tx, { id, reason, now }) : 0;
        if (rolesChanged) {
          await writeAudit(tx, {
            action: 'USER_ROLES_CHANGED',
            entityType: 'user',
            entityId: id,
            details: { before: target.roles, after: updated.roles, sessionsRevoked },
          });
        }
        if (statusChanged) {
          await writeAudit(tx, {
            action: status === USER_STATUS.DEACTIVATED ? 'USER_DEACTIVATED' : 'USER_REACTIVATED',
            entityType: 'user',
            entityId: id,
            details: { before: target.status, after: updated.status, sessionsRevoked },
          });
        }
        await settleAccessRequest(tx, admin, updated, now);
        return { user: updated, revoked: reason && { reason, count: sessionsRevoked } };
      });
      if (result.revoked && result.revoked.count > 0) {
        logSecurityEvent(ctx.logger, 'session_revoked', {
          userId: id,
          reason: result.revoked.reason,
          by: 'ADMIN',
        });
      }
      return toDetail(result.user);
    },

    sendPasswordReset: async (admin, id, ctx) => {
      await transaction(admin, ctx, async (tx, hooks) => {
        const target = guardTarget(admin, await lockManagedUser(tx, id));
        // A deactivated account can't use a reset, so none is sent (owner decision).
        if (target.status === USER_STATUS.DEACTIVATED) throw new AppError('USER_DEACTIVATED');
        await writeAudit(tx, {
          action: 'USER_PASSWORD_RESET_SENT',
          entityType: 'user',
          entityId: target.id,
          details: {},
        });
        await emailOneTimeLink(tx, hooks, 'RESET', target, {
          mail: deps.mail,
          appOrigin: deps.appOrigin,
          logger: ctx.logger,
        });
      });
      logSecurityEvent(ctx.logger, 'password_reset_requested', { userId: id, by: 'ADMIN' });
    },
  };
}
