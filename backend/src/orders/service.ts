import {
  AppError,
  ROLE,
  toMoney,
  type CreateOrderBody,
  type EditOrderBody,
  type Order,
} from '@po/contracts';
import type { AuditLineChange } from '../audit/events.js';
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
import { diffLines, type LineChange } from './line-diff.js';
import {
  bumpOrder,
  deleteOrderLines,
  insertOrder,
  insertOrderLines,
  lockOrder,
  lockOrderLines,
  selectOrder,
  updateOrderLines,
  type OrderRow,
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
  /**
   * Replaces a draft's vendor and lines when `version` is current (research R6): lines with
   * an id are updated, without one added, left out removed, the array order the display
   * order. A save that changes nothing keeps the version and writes no audit entry.
   */
  editOrder(
    buyer: AuthenticatedUser,
    target: { id: string; version: number; body: EditOrderBody },
    ctx: RequestContext,
  ): Promise<Order>;
  /** An order the caller may read (ADR-0004); NOT_FOUND otherwise, never FORBIDDEN. */
  getOrder(user: AuthenticatedUser, id: string): Promise<Order>;
}

/**
 * Who may read an order (ADR-0004): its owner, an Admin, and an Approver once it has left
 * DRAFT. Anyone else gets NOT_FOUND, so a draft's existence isn't revealed.
 */
export function canRead(
  user: Pick<AuthenticatedUser, 'userId' | 'roles'>,
  order: Pick<OrderRow, 'ownerId' | 'status'>,
): boolean {
  return (
    order.ownerId === user.userId ||
    user.roles.includes(ROLE.ADMIN) ||
    (user.roles.includes(ROLE.APPROVER) && order.status !== 'DRAFT')
  );
}

/** One changed line as PO_EDITED records it: only the fields that changed. */
function lineChange(
  change: LineChange,
  lineTotals: { before: string; after: string },
): AuditLineChange {
  const { before, after } = change;
  return {
    id: change.id,
    ...(before.position === after.position
      ? {}
      : { position: { before: before.position, after: after.position } }),
    ...(before.description === after.description
      ? {}
      : { description: { before: before.description, after: after.description } }),
    ...(before.quantity === after.quantity
      ? {}
      : { quantity: { before: before.quantity, after: after.quantity } }),
    ...(before.unitPrice === after.unitPrice
      ? {}
      : { unitPrice: { before: before.unitPrice, after: after.unitPrice } }),
    ...(lineTotals.before === lineTotals.after
      ? {}
      : { lineTotal: { before: toMoney(lineTotals.before), after: toMoney(lineTotals.after) } }),
  };
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
          body.lines.map(({ description, quantity, unitPrice }, position) => ({
            id: uuidv7(),
            position,
            description,
            quantity,
            unitPrice,
          })),
        );
        // Read before the number: the total is derived by now, and the counter row is
        // locked for as short a time as possible.
        const stored = await selectOrder(tx, id);
        if (!stored) throw new Error(`order ${id} vanished inside its own transaction`);

        // The last write before the audit entry: the counter row stays locked from here
        // to commit, whatever the line count (ADR-0001, amended 2026-11-12).
        const poNumber = await assignPoNumber(tx, id);
        const order = toOrder({ ...stored, poNumber });
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

    editOrder: (buyer, { id, version, body }, ctx) =>
      // Lock order (ADR-0006): the order, then its lines, then the vendor; check in the
      // order of ADR-0004 and ADR-0007: not readable 404, version, line ids, vendor.
      runAs(deps.transactions, buyer, ROLE.BUYER, ctx, async (tx) => {
        const locked = await lockOrder(tx, id);
        if (!locked || !canRead(buyer, locked)) throw new AppError('NOT_FOUND');
        // Not reachable while every order is a draft only its owner reads: slices 4 and 5
        // answer a readable order someone else owns, or one past DRAFT, with their codes.
        if (locked.ownerId !== buyer.userId) throw new AppError('FORBIDDEN');
        if (locked.status !== 'DRAFT') throw new AppError('INVALID_STATE_TRANSITION');
        if (locked.version !== version) throw new AppError('VERSION_CONFLICT');
        await lockOrderLines(tx, id);
        const stored = await selectOrder(tx, id);
        if (!stored) throw new Error(`order ${id} vanished under its lock`);
        const before = toOrder(stored);

        const diff = diffLines(
          before.lines.map(({ id: lineId, description, quantity, unitPrice }) => ({
            id: lineId,
            description,
            quantity,
            unitPrice,
          })),
          body.lines,
        );
        if (!diff.ok) throw new AppError('VALIDATION_FAILED', { details: diff.errors });
        // Saving with the current vendor checks it too: a deactivated one is refused.
        await requireActiveVendor(tx, body.vendorId, 'body.vendorId');
        const vendorChanged = body.vendorId !== before.vendor.id;
        if (!vendorChanged && diff.added.length + diff.changed.length + diff.removed.length === 0) {
          return before;
        }

        // At most one statement each, whatever the line count: the total is
        // recomputed once per statement.
        const added = diff.added.map((line) => ({ id: uuidv7(), ...line }));
        await insertOrderLines(tx, id, added);
        await updateOrderLines(
          tx,
          id,
          diff.changed.map((c) => ({ id: c.id, ...c.after })),
        );
        await deleteOrderLines(
          tx,
          id,
          diff.removed.map((line) => line.id),
        );
        await bumpOrder(tx, id, body.vendorId);

        const saved = await selectOrder(tx, id);
        if (!saved) throw new Error(`order ${id} vanished under its lock`);
        const after = toOrder(saved);
        const totalOf = (order: Order, lineId: string) =>
          order.lines.find((line) => line.id === lineId)?.lineTotal ?? '';
        const addedIds = new Set(added.map((line) => line.id));
        const removedIds = new Set(diff.removed.map((line) => line.id));
        await writeAudit(tx, {
          action: 'PO_EDITED',
          entityType: 'order',
          entityId: id,
          orderId: id,
          poNumber: after.poNumber,
          details: {
            ...(vendorChanged
              ? {
                  vendor: {
                    before: { id: before.vendor.id, name: before.vendor.name },
                    after: { id: after.vendor.id, name: after.vendor.name },
                  },
                }
              : {}),
            lines: {
              added: auditLines(after).filter((line) => addedIds.has(line.id)),
              removed: auditLines(before).filter((line) => removedIds.has(line.id)),
              changed: diff.changed.map((change) =>
                lineChange(change, {
                  before: totalOf(before, change.id),
                  after: totalOf(after, change.id),
                }),
              ),
            },
            total: { before: before.total, after: after.total },
          },
        });
        return after;
      }),

    getOrder: async (user, id) => {
      const stored = await withDatabase(() => selectOrder(deps.prisma, id));
      if (!stored || !canRead(user, stored)) throw new AppError('NOT_FOUND');
      return toOrder(stored);
    },
  };
}
