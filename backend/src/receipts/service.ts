import {
  AppError,
  exceedingLinesDetail,
  NOT_ORDER_OWNER_DETAIL,
  ORDER_RECEIPT_FORBIDDEN_DETAIL,
  RECEIPT_TIME_ZONE,
  ROLE,
  type ExceedingLine,
  type FieldError,
  type PageQuery,
  type ReceiptDetail,
  type ReceiptPage,
  type RecordedReceipt,
  type RecordReceiptBody,
  type UserRole,
} from '@po/contracts';
import { lockUsers, type LockedUser } from '../approvals/repository.js';
import type { AuditEvent } from '../audit/events.js';
import { writeAuditBatch } from '../audit/write.js';
import type { AuthenticatedUser } from '../auth/service.js';
import type { AppPrismaClient } from '../db/client.js';
import { withDatabase, type TransactionRunner } from '../db/transaction.js';
import { claimIdempotencyKey, completeIdempotencyKey } from '../idempotency/repository.js';
import { requestHash } from '../idempotency/request-hash.js';
import type { Clock } from '../lib/clock.js';
import { pageArgs } from '../lib/pagination.js';
import type { RequestContext } from '../lib/request-context.js';
import { selectOrderAccess } from '../orders/repository.js';
import { canRead } from '../orders/service.js';
import { runAs } from '../users/actor.js';
import {
  insertReceipt,
  listReceipts,
  lockReceiptLines,
  lockReceiptOrder,
  selectReceipt,
  type ReceiptLineState,
} from './repository.js';

// Goods receipts (ADR-0011; specs/007-goods-receipt/research.md R5–R7). The owner of an
// approved order records what was delivered: one receipt with a quantity per line, all or
// nothing. The database enforces the same rules (D12–D17); the service checks them first
// so a client gets a specific answer.

export interface ReceiptsService {
  /**
   * Records one receipt on the owner's approved order. A retry with the same
   * Idempotency-Key and body (and order) returns the original receipt; another body or
   * order with the same key is IDEMPOTENCY_KEY_REUSED. The order's version never moves.
   */
  recordReceipt(
    buyer: AuthenticatedUser,
    request: { orderId: string; body: RecordReceiptBody; idempotencyKey: string },
    ctx: RequestContext,
  ): Promise<RecordedReceipt>;
  /** The order's receipts, newest first, with their line counts; NOT_FOUND if unreadable. */
  listOrderReceipts(
    user: AuthenticatedUser,
    orderId: string,
    query: PageQuery,
  ): Promise<ReceiptPage>;
  /** One receipt with its lines, if it is on this order and the order is readable. */
  getOrderReceipt(
    user: AuthenticatedUser,
    orderId: string,
    receiptId: string,
  ): Promise<ReceiptDetail>;
}

interface ReceiptsServiceDependencies {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
  clock: Clock;
}

const INDIA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: RECEIPT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today in India time, `YYYY-MM-DD` (research R4: "not after today" is the service's). */
function indiaToday(clock: Clock): string {
  return INDIA_DATE.format(clock.now());
}

function receiptDateError(code: 'DATE_IN_FUTURE' | 'DATE_BEFORE_APPROVAL'): AppError {
  return new AppError('VALIDATION_FAILED', { details: [{ path: 'body.receivedOn', code }] });
}

/** The caller, re-checked under the users-row lock (research R5 step 5). */
function requireStillBuyer(user: LockedUser | undefined): void {
  if (!user || user.status !== 'ACTIVE') throw new AppError('ACCOUNT_DEACTIVATED');
  if (!user.roles.includes(ROLE.BUYER)) {
    const details: Partial<Record<UserRole, string>> = ORDER_RECEIPT_FORBIDDEN_DETAIL;
    const detail = user.roles.map((role) => details[role]).find((d) => d !== undefined);
    throw new AppError('FORBIDDEN', detail === undefined ? {} : { detail });
  }
}

/** Every line the receipt would take above its ordered quantity, in position order. */
function exceedingLines(
  body: RecordReceiptBody,
  locked: ReadonlyMap<string, ReceiptLineState>,
): ExceedingLine[] {
  return body.lines
    .flatMap(({ lineId, quantity }) => {
      const line = locked.get(lineId);
      if (!line) return [];
      const outstanding = line.quantity - line.receivedQuantity;
      return quantity > outstanding
        ? [{ lineId, position: line.position, outstanding, requested: quantity }]
        : [];
    })
    .sort((a, b) => a.position - b.position);
}

export function createReceiptsService(deps: ReceiptsServiceDependencies): ReceiptsService {
  return {
    recordReceipt: (buyer, { orderId, body, idempotencyKey }, ctx) => {
      // Step 2 (research R5): a date after today in India is a shape error, before the key.
      if (body.receivedOn > indiaToday(deps.clock)) throw receiptDateError('DATE_IN_FUTURE');
      return runAs(deps.transactions, buyer, ROLE.BUYER, ctx, async (tx) => {
        const key = {
          userId: buyer.userId,
          operation: 'recordReceipt',
          key: idempotencyKey,
        } as const;
        // The hash covers the order too: the same key on another order is a reuse.
        const claim = await claimIdempotencyKey(tx, {
          ...key,
          requestHash: requestHash({ orderId, body }),
        });
        if (claim.kind === 'reused') throw new AppError('IDEMPOTENCY_KEY_REUSED');
        if (claim.kind === 'replay') return claim.response as RecordedReceipt;

        // Every lock first, in ADR-0006's order (key, order, lines id asc, the caller's
        // users row FOR SHARE); then the checks in research R5's order.
        const order = await lockReceiptOrder(tx, orderId);
        const lines = order
          ? await lockReceiptLines(
              tx,
              orderId,
              body.lines.map((l) => l.lineId),
            )
          : [];
        const users = await lockUsers(tx, [buyer.userId]);

        if (!order || !canRead(buyer, order)) throw new AppError('NOT_FOUND');
        if (order.ownerId !== buyer.userId) {
          throw new AppError('NOT_ORDER_OWNER', { detail: NOT_ORDER_OWNER_DETAIL });
        }
        requireStillBuyer(users.get(buyer.userId));
        if (order.status !== 'APPROVED' || order.approvedOn === null || order.poNumber === null) {
          throw new AppError('ORDER_NOT_RECEIVABLE', { orderState: { status: order.status } });
        }
        const byId = new Map(lines.map((line) => [line.id, line]));
        const missing: FieldError[] = body.lines.flatMap(({ lineId }, index) =>
          byId.has(lineId)
            ? []
            : [{ path: `body.lines.${String(index)}.lineId`, code: 'LINE_NOT_FOUND' }],
        );
        if (missing.length > 0) throw new AppError('VALIDATION_FAILED', { details: missing });
        if (body.receivedOn < order.approvedOn) throw receiptDateError('DATE_BEFORE_APPROVAL');
        const exceeding = exceedingLines(body, byId);
        if (exceeding.length > 0) {
          throw new AppError('RECEIPT_EXCEEDS_OUTSTANDING', {
            lines: exceeding,
            detail: exceedingLinesDetail(exceeding),
          });
        }

        const note = body.note ?? null;
        const written = await insertReceipt(tx, {
          orderId,
          receivedOn: body.receivedOn,
          recordedBy: buyer.userId,
          note,
          lines: body.lines,
        });
        // Before and after come from the lines read under lock: no read-back (R6).
        const receiptLines = body.lines
          .map(({ lineId, quantity }) => {
            const line = byId.get(lineId) as ReceiptLineState;
            const receivedAfter = line.receivedQuantity + quantity;
            return {
              lineId,
              position: line.position,
              quantity,
              receivedBefore: line.receivedQuantity,
              receivedAfter,
              outstandingAfter: line.quantity - receivedAfter,
            };
          })
          .sort((a, b) => a.position - b.position);
        const completed = receiptLines.filter(
          (l) => l.outstandingAfter === 0 && l.receivedBefore < l.receivedAfter,
        ).length;
        const recordedAt = written.recordedAt.toISOString();
        const receipt: RecordedReceipt = {
          id: written.id,
          receivedOn: body.receivedOn,
          recordedAt,
          note,
          receiptProgress:
            order.openLineCount - completed === 0 ? 'FULLY_RECEIVED' : 'PARTIALLY_RECEIVED',
          lines: receiptLines,
        };
        const poNumber = order.poNumber;
        await writeAuditBatch(
          tx,
          receiptLines.map((line): AuditEvent => ({
            action: 'GOODS_RECEIPT_RECORDED',
            entityType: 'order',
            entityId: orderId,
            orderId,
            poNumber,
            details: {
              receiptId: written.id,
              ...line,
              receivedOn: body.receivedOn,
              recordedAt,
              note,
            },
          })),
        );
        await completeIdempotencyKey(tx, { ...key, status: 201, response: receipt });
        return receipt;
      });
    },

    listOrderReceipts: async (user, orderId, query) => {
      const order = await withDatabase(() => selectOrderAccess(deps.prisma, orderId));
      if (!order || !canRead(user, order)) throw new AppError('NOT_FOUND');
      const { rows, total } = await withDatabase(() =>
        listReceipts(deps.prisma, orderId, pageArgs(query)),
      );
      return {
        items: rows.map((row) => ({
          id: row.id,
          receivedOn: row.receivedOn,
          recordedAt: row.recordedAt.toISOString(),
          recordedBy: { id: row.recordedById, name: row.recordedByName },
          note: row.note,
          lineCount: row.lineCount,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    },

    getOrderReceipt: async (user, orderId, receiptId) => {
      const order = await withDatabase(() => selectOrderAccess(deps.prisma, orderId));
      if (!order || !canRead(user, order)) throw new AppError('NOT_FOUND');
      const row = await withDatabase(() => selectReceipt(deps.prisma, orderId, receiptId));
      if (!row) throw new AppError('NOT_FOUND');
      return {
        id: row.id,
        receivedOn: row.receivedOn,
        recordedAt: row.recordedAt.toISOString(),
        recordedBy: { id: row.recordedById, name: row.recordedByName },
        note: row.note,
        lines: row.lines.map((l) => ({
          line: { id: l.lineId, position: l.position, description: l.description },
          quantity: l.quantity,
        })),
      };
    },
  };
}
