import { AppError, ROLE, type CreateOrderBody, type Order } from '@po/contracts';
import type { AuthenticatedUser } from '../auth/service.js';
import { writeAudit } from '../audit/write.js';
import type { AppPrismaClient } from '../db/client.js';
import { withDatabase, type TransactionRunner } from '../db/transaction.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../idempotency/repository.js';
import { requestHash } from '../idempotency/request-hash.js';
import type { RequestContext } from '../lib/request-context.js';
import { uuidv7 } from '../lib/uuid.js';
import { runAs } from '../users/actor.js';
import { requireActiveVendor } from '../vendors/service.js';
import { auditLines, toOrder } from './order.js';
import { assignPoNumber } from './po-number.js';
import {
  insertOrder,
  insertOrderLines,
  selectOrderHeader,
  selectOrderLines,
  type OrderHeaderRow,
} from './repository.js';

// Purchase orders (ADR-0001, ADR-0003, ADR-0004; specs/004-draft-orders). Drafts only in
// this slice.

export interface CreatedOrder {
  order: Order;
  /** True when the Idempotency-Key was seen with this body: the original result, again. */
  replayed: boolean;
}

export interface OrdersService {
  /**
   * Raises a draft for the Buyer. A retry with the same Idempotency-Key and body returns
   * the original order; the same key with another body is IDEMPOTENCY_KEY_REUSED.
   */
  createOrder(
    buyer: AuthenticatedUser,
    request: { body: CreateOrderBody; idempotencyKey: string },
    ctx: RequestContext,
  ): Promise<CreatedOrder>;
  /** An order the caller may read (ADR-0004); NOT_FOUND otherwise, never FORBIDDEN. */
  getOrder(user: AuthenticatedUser, id: string): Promise<Order>;
}

/**
 * Who may read an order (ADR-0004): its owner, an Admin, and an Approver once it has left
 * DRAFT. Anyone else gets NOT_FOUND, so a draft's existence isn't revealed.
 */
export function canRead(
  user: Pick<AuthenticatedUser, 'userId' | 'roles'>,
  order: Pick<OrderHeaderRow, 'ownerId' | 'status'>,
): boolean {
  return (
    order.ownerId === user.userId ||
    user.roles.includes(ROLE.ADMIN) ||
    (user.roles.includes(ROLE.APPROVER) && order.status !== 'DRAFT')
  );
}

interface OrdersServiceDependencies {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
}

export function createOrdersService(deps: OrdersServiceDependencies): OrdersService {
  return {
    createOrder: (buyer, { body, idempotencyKey }, ctx) =>
      // One transaction (research R2, R5): the key, the order, its lines, its PO number
      // and its audit entry commit or roll back together. It locks only what it must, in
      // this order: the key's row (a concurrent retry waits on it), the vendor FOR SHARE
      // (it can't be deactivated under us), the new order (its line trigger), and the
      // financial year's counter row last, so creates queue there for the shortest time.
      runAs(deps.transactions, buyer, ROLE.BUYER, ctx, async (tx) => {
        const key = {
          userId: buyer.userId,
          operation: 'createOrder',
          key: idempotencyKey,
        } as const;
        const claim = await claimIdempotencyKey(tx, { ...key, requestHash: requestHash(body) });
        if (claim.kind === 'reused') throw new AppError('IDEMPOTENCY_KEY_REUSED');
        if (claim.kind === 'replay') return { order: claim.response as Order, replayed: true };

        await requireActiveVendor(tx, body.vendorId, 'body.vendorId');
        const id = uuidv7();
        // Only the columns a request may set: anything else on `body` is never read.
        await insertOrder(tx, { id, ownerId: buyer.userId, vendorId: body.vendorId });
        await insertOrderLines(
          tx,
          id,
          body.lines.map(({ description, quantity, unitPrice }) => ({
            description,
            quantity,
            unitPrice,
          })),
        );
        const header = await selectOrderHeader(tx, id);
        if (!header) throw new Error(`order ${id} vanished inside its own transaction`);
        const lines = await selectOrderLines(tx, id);

        // The last write before the audit entry: the counter row stays locked from here
        // to commit, whatever the line count (ADR-0001, amended 2026-11-12).
        const poNumber = await assignPoNumber(tx, id);
        const order = toOrder({ ...header, poNumber }, lines);
        await writeAudit(tx, {
          action: 'PO_CREATED',
          entityType: 'order',
          entityId: id,
          orderId: id,
          poNumber,
          details: {
            vendor: { id: order.vendor.id, name: order.vendor.name },
            lines: auditLines(order),
            total: order.total,
          },
        });
        await completeIdempotencyKey(tx, { ...key, status: 201, response: order });
        return { order, replayed: false };
      }),

    getOrder: async (user, id) => {
      const [header, lines] = await withDatabase(() =>
        Promise.all([selectOrderHeader(deps.prisma, id), selectOrderLines(deps.prisma, id)]),
      );
      if (!header || !canRead(user, header)) throw new AppError('NOT_FOUND');
      return toOrder(header, lines);
    },
  };
}
