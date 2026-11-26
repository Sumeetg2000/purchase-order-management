import {
  ORDER_ADMIN_READ_ONLY_MESSAGE,
  ORDER_RECEIPT_APPROVER_MESSAGE,
  type AppError,
} from '@po/contracts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '../../src/auth/service.js';
import { createPrismaClient } from '../../src/db/client.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { createReceiptsService } from '../../src/receipts/service.js';
import type { CookieJar } from '../support/accounts.js';
import { testClock } from '../support/clock.js';
import { testLogger } from '../support/log-capture.js';
import { orderFixture, plant } from '../support/orders-sql.js';
import { approvalDate, approvedOrder } from '../support/receipts-sql.js';
import {
  indiaDate,
  indiaHalfPastMidnight,
  receiptBody,
  receiptsHarness,
  type ReceiptsHarness,
} from '../support/receipts.js';

// Who may record a receipt, and on what (US3, FR-010–FR-012, FR-OWN-01; ADR-0004's receipt
// row; research R5): only the order's owner, still an active Buyer under lock, and only on
// an APPROVED order. Every refusal leaves the lines, the receipts and the audit unchanged.
// The route-level cells (anonymous, no role, Admin, pure Approver × every operation) are in
// authorization-matrix.test.ts; these are the cells that need a real order.

const UNKNOWN_ORDER = '00000000-0000-7000-8000-000000000000';

/** What a refused receipt must leave untouched, read from the database. */
async function snapshot(h: ReceiptsHarness, id: string) {
  const lines = await h.query<{ received_quantity: number }>(
    `SELECT received_quantity FROM order_lines WHERE order_id = $1 ORDER BY position`,
    [id],
  );
  return {
    received: lines.map((l) => l.received_quantity),
    counts: await h.receiptCounts(id),
    audit: (await h.receiptAudit()).length,
  };
}

/** An approved order of 10, the clock at 00:30 India on its approval day. */
async function approvedTen() {
  const h = await receiptsHarness();
  const order = await h.approvedOrder([10]);
  const jar = await h.setClock(indiaHalfPastMidnight(order.approvedOn));
  return { h, jar, ...order, lineId: order.lineIds[0] ?? '' };
}

describe('[FR-OWN-01] the receipt row: who records receipts', () => {
  it('[FR-OWN-01] the owner records; another Buyer gets 404; a Buyer+Approver who does not own it gets 403 NOT_ORDER_OWNER', async () => {
    const { h, id, lineId, approvedOn } = await approvedTen();
    const body = receiptBody(approvedOn, [{ lineId, quantity: 1 }]);
    const before = await snapshot(h, id);
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}', name: 'Other Buyer' }));
    const both = await h.loggedIn(await h.seedUser({ roles: '{BUYER,APPROVER}', name: 'Dual' }));

    const notFound = await h.recordReceipt(id, body, { as: other });
    expect(notFound.status).toBe(404);
    expect(notFound.body).toMatchObject({ code: 'NOT_FOUND' });
    const notOwner = await h.recordReceipt(id, body, { as: both });
    expect(notOwner.status).toBe(403);
    expect(notOwner.body).toMatchObject({ code: 'NOT_ORDER_OWNER' });
    expect(await snapshot(h, id)).toEqual(before);

    expect((await h.recordReceipt(id, body)).status).toBe(201);
  });

  it("[FR-APR-01] a pure Approver gets 403 FORBIDDEN with the receipt's message, before any lookup or validation", async () => {
    const { h, id, lineId, approvedOn } = await approvedTen();
    const priya = await h.approver();
    const before = await snapshot(h, id);
    for (const [name, orderId, body] of [
      ['an approved order', id, receiptBody(approvedOn, [{ lineId, quantity: 1 }])],
      [
        'an order that does not exist',
        UNKNOWN_ORDER,
        receiptBody(approvedOn, [{ lineId, quantity: 1 }]),
      ],
      ['a body that is not valid', id, { lines: 'none' }],
    ] as const) {
      const res = await h.recordReceipt(orderId, body, { as: priya.jar });
      expect(res.status, name).toBe(403);
      expect(res.body, name).toMatchObject({
        code: 'FORBIDDEN',
        detail: ORDER_RECEIPT_APPROVER_MESSAGE,
      });
    }
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const res = await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId, quantity: 1 }]), {
      as: admin,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', detail: ORDER_ADMIN_READ_ONLY_MESSAGE });
    expect(await snapshot(h, id)).toEqual(before);
  });
});

describe('[FR-SM-01] the receipt row × order states', () => {
  it('[FR-SM-01] the owner on a draft, pending, rejected or cancelled order: 409 ORDER_NOT_RECEIVABLE with the status', async () => {
    const h = await receiptsHarness();
    const priya = await h.approver();
    const draft = await h.draftAt('10');
    const pending = await h.draftAt('150000');
    await h.submitOrder(pending.id, 1);
    const rejected = await h.draftAt('150000');
    await h.submitOrder(rejected.id, 1);
    await h.rejectOrder(rejected.id, 2, priya.jar, { reason: 'Too costly' });
    const cancelled = await h.draftAt('10');
    await h.submitOrder(cancelled.id, 1);
    await h.cancelOrder(cancelled.id, 2, priya.jar, { reason: 'Supplier closed' });
    const jar = await h.setClock(new Date());
    const today = indiaDate(new Date());
    for (const [status, order] of [
      ['DRAFT', draft],
      ['PENDING_APPROVAL', pending],
      ['REJECTED', rejected],
      ['CANCELLED', cancelled],
    ] as const) {
      const before = await snapshot(h, order.id);
      const res = await h.recordReceipt(
        order.id,
        receiptBody(today, [{ lineId: order.lines[0]?.id ?? '', quantity: 1 }]),
        { as: jar },
      );
      expect(res.status, status).toBe(409);
      expect(res.body, status).toMatchObject({
        code: 'ORDER_NOT_RECEIVABLE',
        orderState: { status },
      });
      expect(await snapshot(h, order.id), status).toEqual(before);
    }
  });
});

describe('[FR-RCV-03] the receipts read row', () => {
  it('[FR-RCV-03] owner, Buyer+Approver, Approver and Admin read; another Buyer gets 404', async () => {
    const { h, id, lineId, approvedOn } = await approvedTen();
    const receiptId = (
      (await h.recordReceipt(id, receiptBody(approvedOn, [{ lineId, quantity: 1 }]))).body as {
        id: string;
      }
    ).id;
    const callers: [string, CookieJar | undefined, number][] = [
      ['owner', undefined, 200],
      ['Buyer+Approver', await h.loggedIn(await h.seedUser({ roles: '{BUYER,APPROVER}' })), 200],
      ['Approver', (await h.approver()).jar, 200],
      ['Admin', await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' })), 200],
      ['another Buyer', await h.loggedIn(await h.seedUser({ roles: '{BUYER}' })), 404],
    ];
    for (const [who, jar, status] of callers) {
      expect((await h.listReceipts(id, jar)).status, who).toBe(status);
      expect((await h.getReceipt(id, receiptId, jar)).status, who).toBe(status);
    }
  });
});

describe('[FR-ACC-07] the caller, re-checked when the receipt runs', () => {
  it('[FR-ACC-07] the owner without BUYER gets 403 FORBIDDEN; deactivated, 401; restored, they receive again', async () => {
    const { h, id, lineId, approvedOn } = await approvedTen();
    const body = () => receiptBody(approvedOn, [{ lineId, quantity: 1 }]);
    const before = await snapshot(h, id);

    await h.setUser(h.buyer.id, { roles: '{APPROVER}' });
    const noBuyer = await h.recordReceipt(id, body());
    expect(noBuyer.status).toBe(403);
    expect(noBuyer.body).toMatchObject({ code: 'FORBIDDEN' });

    await h.setUser(h.buyer.id, { roles: '{BUYER}', status: 'DEACTIVATED' });
    const deactivated = await h.recordReceipt(id, body());
    expect(deactivated.status).toBe(401);
    expect(deactivated.body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
    expect(await snapshot(h, id)).toEqual(before);

    await h.setUser(h.buyer.id, { status: 'ACTIVE' });
    expect((await h.recordReceipt(id, body())).status).toBe(201);
  });
});

describe('[FR-ACT-01] the order of the receipt checks (ADR-0004, 2026-11-24)', () => {
  it('[FR-ACT-01] not the owner before the state; the state before line and date checks; line before date', async () => {
    const h = await receiptsHarness();
    const priya = await h.approver();
    const cancelled = await h.approvedOrder([10]);
    await h.cancelOrder(cancelled.id, 2, priya.jar, { reason: 'Supplier closed' });
    const approved = await h.approvedOrder([10]);
    const foreign = await h.approvedOrder([10]);
    const jar = await h.setClock(indiaHalfPastMidnight(approved.approvedOn));
    const [row] = await h.query<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [
      approved.approvedOn,
    ]);
    const dayBefore = row?.d ?? '';
    const bad = (lineId: string) => receiptBody(dayBefore, [{ lineId, quantity: 99 }]);

    // A Buyer+Approver on someone else's cancelled order: NOT_ORDER_OWNER, not the state.
    const dual = await h.loggedIn(await h.seedUser({ roles: '{BUYER,APPROVER}' }));
    const notOwner = await h.recordReceipt(cancelled.id, bad(cancelled.lineIds[0] ?? ''), {
      as: dual,
    });
    expect(notOwner.body).toMatchObject({ code: 'NOT_ORDER_OWNER' });

    // The owner on the cancelled order, with a foreign line and a date before approval.
    const state = await h.recordReceipt(cancelled.id, bad(foreign.lineIds[0] ?? ''), { as: jar });
    expect(state.status).toBe(409);
    expect(state.body).toMatchObject({ code: 'ORDER_NOT_RECEIVABLE' });

    // On the approved order: the foreign line first, then the date, then the quantity.
    const line = await h.recordReceipt(approved.id, bad(foreign.lineIds[0] ?? ''), { as: jar });
    expect(line.body).toMatchObject({
      details: [{ path: 'body.lines.0.lineId', code: 'LINE_NOT_FOUND' }],
    });
    const date = await h.recordReceipt(approved.id, bad(approved.lineIds[0] ?? ''), { as: jar });
    expect(date.body).toMatchObject({
      details: [{ path: 'body.receivedOn', code: 'DATE_BEFORE_APPROVAL' }],
    });
  });
});

describe('[FR-ACC-07] the re-check under lock, past the route check', () => {
  /**
   * The route saw an active Buyer; by the time the receipt locks the users row, the
   * database says otherwise (the race window, made deterministic by calling the service
   * with the user as the route saw them).
   */
  async function recordAsStaleBuyer(change: { roles?: string; status?: 'DEACTIVATED' }) {
    const f = await orderFixture();
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    const receivedOn = await approvalDate(f.app, orderId);
    await plant(
      f,
      `UPDATE users SET roles = coalesce($2::text[], roles), status = coalesce($3, status),
              deactivated_at = CASE WHEN $3 = 'DEACTIVATED' THEN now() END
        WHERE id = $1`,
      [f.buyerId, change.roles ?? null, change.status ?? null],
    );
    const prisma = createPrismaClient({
      url: f.db.url('po_app'),
      poolSize: 2,
      connectionTimeoutMs: 2_000,
    });
    try {
      const receipts = createReceiptsService({
        prisma,
        transactions: createTransactionRunner({ prisma, timeoutMs: 10_000, maxWaitMs: 2_000 }),
        clock: testClock(new Date()),
      });
      const seenByRoute: AuthenticatedUser = {
        userId: f.buyerId,
        sessionId: randomUUID(),
        name: 'Bea Buyer',
        email: 'bea@example.local',
        roles: ['BUYER'],
      };
      const error = await receipts
        .recordReceipt(
          seenByRoute,
          {
            orderId,
            idempotencyKey: randomUUID(),
            body: { receivedOn, lines: [{ lineId: lineIds[0] ?? '', quantity: 1 }] },
          },
          { requestId: 'req-stale-0001', logger: testLogger(), ip: '127.0.0.1', userAgent: 'test' },
        )
        .then(
          () => undefined,
          (e: unknown) => e as AppError,
        );
      const { rows } = await f.app.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM goods_receipts WHERE order_id = $1`,
        [orderId],
      );
      return { error, receipts: rows[0]?.n };
    } finally {
      await prisma.$disconnect();
    }
  }

  it('[FR-ACC-07] BUYER removed after the route check: 403 FORBIDDEN with the role detail; nothing recorded', async () => {
    const { error, receipts } = await recordAsStaleBuyer({ roles: '{APPROVER}' });
    expect(error).toMatchObject({ code: 'FORBIDDEN', detail: ORDER_RECEIPT_APPROVER_MESSAGE });
    expect(receipts).toBe(0);
  });

  it('[FR-ACC-07] deactivated after the route check: 401 ACCOUNT_DEACTIVATED; nothing recorded', async () => {
    const { error, receipts } = await recordAsStaleBuyer({ status: 'DEACTIVATED' });
    expect(error).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
    expect(receipts).toBe(0);
  });
});
