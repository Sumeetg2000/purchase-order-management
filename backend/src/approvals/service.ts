import {
  AppError,
  NOT_ORDER_OWNER_DETAIL,
  ORDER_DECISION_FORBIDDEN_DETAIL,
  ORDER_OWNER_INACTIVE_DETAIL,
  ROLE,
  SELF_APPROVAL_DETAIL,
  toMoney,
  type ApprovalPolicy,
  type ApprovalQueueItem,
  type ApprovalQueueQuery,
  type Order,
  type Page,
  type UserRole,
} from '@po/contracts';
import type { AuthenticatedUser } from '../auth/service.js';
import { writeAudit } from '../audit/write.js';
import type { AppPrismaClient } from '../db/client.js';
import {
  asSystem,
  withDatabase,
  type AuditedTransaction,
  type TransactionRunner,
} from '../db/transaction.js';
import { pageArgs } from '../lib/pagination.js';
import type { RequestContext } from '../lib/request-context.js';
import { toOrder } from '../orders/order.js';
import { lockOrder, selectOrder } from '../orders/repository.js';
import { canRead } from '../orders/service.js';
import { runAs } from '../users/actor.js';
import { lockVendorStatus, requireActiveVendor } from '../vendors/service.js';
import {
  approveRoundAndOrder,
  approveStep,
  autoApprove,
  bumpOrderVersion,
  insertRound,
  listApprovalQueue,
  lockSteps,
  lockUsers,
  type LockedUser,
  insertSteps,
  lowestThreshold,
  moveToPending,
  selectCurrentPolicy,
} from './repository.js';

// Submission and routing (specs/005-submit-approve, research R3–R6). Each command is one
// short transaction that locks in ADR-0006's order, checks in ADR-0004's precedence, and
// writes its audit entries before it commits.

export interface ApprovalsService {
  /** Submit a draft: routed by its exact total; auto-approved by SYSTEM at or below the tier. */
  submitOrder(
    buyer: AuthenticatedUser,
    target: { id: string; version: number },
    ctx: RequestContext,
  ): Promise<Order>;
  /** The current policy, for every role. */
  getApprovalPolicy(): Promise<ApprovalPolicy>;
  /** Approve the current step of a pending order: T6, or T7 on the last step. */
  approveOrder(
    approver: AuthenticatedUser,
    target: { id: string; version: number },
    ctx: RequestContext,
  ): Promise<Order>;
  /** Pending orders the caller may approve, never their own (research R7). */
  listApprovalQueue(
    approver: AuthenticatedUser,
    query: ApprovalQueueQuery,
  ): Promise<Page<ApprovalQueueItem>>;
}

/**
 * The acting Approver, re-checked under the lock of their own row (ADR-0004, 2026-11-17):
 * a deactivation or role removal that committed since the request's own check refuses the
 * decision with the same codes that check gives.
 */
function requireStillApprover(approver: LockedUser | undefined): void {
  if (!approver || approver.status !== 'ACTIVE') throw new AppError('ACCOUNT_DEACTIVATED');
  if (!approver.roles.includes(ROLE.APPROVER)) {
    const detail = approver.roles
      .map(
        (role: UserRole) =>
          (ORDER_DECISION_FORBIDDEN_DETAIL as Partial<Record<UserRole, string>>)[role],
      )
      .find((d) => d !== undefined);
    throw new AppError('FORBIDDEN', detail === undefined ? {} : { detail });
  }
}

/** The owner can still act on their order: active and holding BUYER (ADR-0001). */
function ownerCanAct(owner: LockedUser | undefined): boolean {
  return owner?.status === 'ACTIVE' && owner.roles.includes(ROLE.BUYER);
}

async function readOrder(tx: AuditedTransaction, id: string): Promise<Order> {
  const stored = await selectOrder(tx, id);
  if (!stored) throw new Error(`order ${id} vanished under its lock`);
  return toOrder(stored);
}

interface ApprovalsServiceDependencies {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
}

export function createApprovalsService(deps: ApprovalsServiceDependencies): ApprovalsService {
  return {
    submitOrder: (buyer, { id, version }, ctx) =>
      // Locks: the order, then the vendor FOR SHARE (research R6). The lines need no lock:
      // every line change locks its order first, so the total can't move under us.
      runAs(deps.transactions, buyer, ROLE.BUYER, ctx, async (tx) => {
        const locked = await lockOrder(tx, id);
        if (!locked || !canRead(buyer, locked)) throw new AppError('NOT_FOUND');
        if (locked.ownerId !== buyer.userId) {
          throw new AppError('NOT_ORDER_OWNER', { detail: NOT_ORDER_OWNER_DETAIL });
        }
        if (locked.status !== 'DRAFT') {
          throw new AppError('INVALID_STATE_TRANSITION', {
            orderState: { status: locked.status, action: 'SUBMIT' },
          });
        }
        if (locked.version !== version) throw new AppError('VERSION_CONFLICT');
        const vendor = await requireActiveVendor(tx, locked.vendorId, 'vendorId');

        const round = await insertRound(tx, id, vendor);
        const steps = await insertSteps(tx, id, round.round);
        const draft = await selectOrder(tx, id);
        if (!draft?.poNumber) throw new Error(`order ${id} vanished under its lock`);
        const where = {
          entityType: 'order',
          entityId: id,
          orderId: id,
          poNumber: draft.poNumber,
        } as const;
        await writeAudit(tx, {
          ...where,
          action: 'PO_SUBMITTED',
          details: {
            round: round.round,
            total: toMoney(round.total),
            tiers: steps.map((s) => ({ tier: s.tier, threshold: toMoney(s.threshold) })),
            policyVersion: round.policyVersion,
            resultingStatus: steps.length === 0 ? 'APPROVED' : 'PENDING_APPROVAL',
            vendorSnapshot: vendor,
          },
        });
        if (steps.length === 0) {
          // The system's decision, inside the owner's command (research R5).
          const threshold = await lowestThreshold(tx, round.policyVersion);
          await asSystem(tx, async () => {
            await autoApprove(tx, id, round.round);
            await writeAudit(tx, {
              ...where,
              action: 'PO_AUTO_APPROVED',
              details: {
                round: round.round,
                threshold: toMoney(threshold),
                policyVersion: round.policyVersion,
              },
            });
          });
        } else {
          await moveToPending(tx, id, round.round);
        }
        const stored = await selectOrder(tx, id);
        if (!stored) throw new Error(`order ${id} vanished under its lock`);
        return toOrder(stored);
      }),

    approveOrder: (approver, { id, version }, ctx) =>
      // Locks first, in ADR-0006's order: the order, its current round's steps, the
      // vendor, then the owner's and the Approver's users rows in id order. Then the checks,
      // in ADR-0004's precedence (research R8).
      runAs(deps.transactions, approver, ROLE.APPROVER, ctx, async (tx) => {
        const locked = await lockOrder(tx, id);
        const steps =
          locked?.status === 'PENDING_APPROVAL' && locked.currentRound !== null
            ? await lockSteps(tx, id, locked.currentRound)
            : [];
        const vendorStatus = locked ? await lockVendorStatus(tx, locked.vendorId) : null;
        const users = await lockUsers(
          tx,
          locked ? [locked.ownerId, approver.userId] : [approver.userId],
        );

        requireStillApprover(users.get(approver.userId));
        if (!locked || !canRead(approver, locked)) throw new AppError('NOT_FOUND');
        if (locked.ownerId === approver.userId) {
          throw new AppError('SELF_APPROVAL', { detail: SELF_APPROVAL_DETAIL });
        }
        const open = steps.find((step) => step.state === 'OPEN');
        if (locked.status !== 'PENDING_APPROVAL' || locked.currentRound === null || !open) {
          throw new AppError('INVALID_STATE_TRANSITION', {
            orderState: { status: locked.status, action: 'APPROVE' },
          });
        }
        if (locked.version !== version) throw new AppError('VERSION_CONFLICT');
        if (vendorStatus !== 'ACTIVE') throw new AppError('VENDOR_INACTIVE');
        if (!ownerCanAct(users.get(locked.ownerId))) {
          throw new AppError('ORDER_OWNER_INACTIVE', { detail: ORDER_OWNER_INACTIVE_DETAIL });
        }

        const round = locked.currentRound;
        await approveStep(tx, {
          orderId: id,
          round,
          step: open.step,
          approverId: approver.userId,
          version,
        });
        const last = steps.every((step) => step.step === open.step || step.state === 'APPROVED');
        if (last) await approveRoundAndOrder(tx, id, round);
        else await bumpOrderVersion(tx, id);
        const order = await readOrder(tx, id);
        await writeAudit(tx, {
          action: 'APPROVAL_STEP_APPROVED',
          entityType: 'order',
          entityId: id,
          orderId: id,
          poNumber: order.poNumber,
          details: { round, step: open.step, tier: open.tier, versionApproved: version },
        });
        return order;
      }),

    listApprovalQueue: async (approver, query) => {
      const { total, items } = await withDatabase(() =>
        listApprovalQueue(
          deps.prisma,
          approver.userId,
          { vendorId: query.vendorId, poNumber: query.poNumber },
          pageArgs(query),
        ),
      );
      return {
        items: items.map((row) => ({
          ...row,
          total: toMoney(row.total),
          submittedAt: new Date(row.submittedAt).toISOString(),
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    },

    getApprovalPolicy: async () => {
      const policy = await withDatabase(() => selectCurrentPolicy(deps.prisma));
      return {
        version: policy.version,
        effectiveAt: policy.effectiveAt.toISOString(),
        tiers: policy.tiers.map((t) => ({ tier: t.tier, threshold: toMoney(t.threshold) })),
      };
    },
  };
}
