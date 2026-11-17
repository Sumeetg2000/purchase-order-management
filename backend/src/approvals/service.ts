import {
  AppError,
  NOT_ORDER_OWNER_DETAIL,
  ROLE,
  toMoney,
  type ApprovalPolicy,
  type Order,
} from '@po/contracts';
import type { AuthenticatedUser } from '../auth/service.js';
import { writeAudit } from '../audit/write.js';
import type { AppPrismaClient } from '../db/client.js';
import { asSystem, withDatabase, type TransactionRunner } from '../db/transaction.js';
import type { RequestContext } from '../lib/request-context.js';
import { toOrder } from '../orders/order.js';
import { lockOrder, selectOrder } from '../orders/repository.js';
import { canRead } from '../orders/service.js';
import { runAs } from '../users/actor.js';
import { requireActiveVendor } from '../vendors/service.js';
import {
  autoApprove,
  insertRound,
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
