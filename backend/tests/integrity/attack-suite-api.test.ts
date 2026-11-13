import { createOrderBody, type CreateOrderBody } from '@po/contracts';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { createOrdersService } from '../../src/orders/service.js';
import { lineBody, ordersHarness } from '../support/orders.js';
import { testLogger } from '../support/log-capture.js';

// The integrity attack suite, API and service part (FR-014): a derived or system-assigned
// value in a create body is refused with READ_ONLY_FIELD, never ignored; a price can't
// arrive as a float; and a service call handed such a value can't store it. The shared
// afterEach reconciles every test database (tests/support/setup.ts).

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

describe('[FR-PO-04] attacks through the API', () => {
  it('[FR-PO-04] total, lineTotal, openLineCount, poNumber or receivedQuantity in a create body is READ_ONLY_FIELD', async () => {
    const h = await ordersHarness();
    for (const [where, field] of [
      ['order', 'total'],
      ['order', 'openLineCount'],
      ['order', 'poNumber'],
      ['line', 'lineTotal'],
      ['line', 'receivedQuantity'],
    ] as const) {
      const body =
        where === 'order'
          ? h.orderBody([lineBody()], { [field]: '0.0001' })
          : h.orderBody([lineBody({ [field]: '0.0001' })]);
      const res = await h.createOrder(body);
      const path = where === 'order' ? `body.${field}` : `body.lines.0.${field}`;
      expect(res.status, field).toBe(400);
      expect(res.body, field).toMatchObject({ details: [{ path, code: 'READ_ONLY_FIELD' }] });
    }
    expect(await h.count('purchase_orders')).toBe(0);
  });

  it('[FR-PO-07] a unit price sent as a JSON number is refused: no float ever becomes money', async () => {
    const h = await ordersHarness();
    const res = await h.createOrder(h.orderBody([lineBody({ unitPrice: 0.1 })]));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      details: [{ path: 'body.lines.0.unitPrice', code: 'INVALID_FORMAT' }],
    });
  });
});

describe('[FR-PO-04] attacks through an edit', () => {
  it('[FR-PO-04] total or lineTotal in an edit body or line is READ_ONLY_FIELD, and nothing changes', async () => {
    const h = await ordersHarness();
    const order = (await h.createOrder(h.orderBody([lineBody({ quantity: 2, unitPrice: '5' })])))
      .body as { id: string; lines: { id: string }[] };
    const line = { ...lineBody({ quantity: 2, unitPrice: '5' }), id: order.lines[0]?.id };
    const inBody = await h.editOrder(order.id, h.orderBody([line], { total: '1' }), 1);
    expect(inBody.status).toBe(400);
    expect(inBody.body).toMatchObject({
      details: [{ path: 'body.total', code: 'READ_ONLY_FIELD' }],
    });
    const inLine = await h.editOrder(order.id, h.orderBody([{ ...line, lineTotal: '1' }]), 1);
    expect(inLine.body).toMatchObject({
      details: [{ path: 'body.lines.0.lineTotal', code: 'READ_ONLY_FIELD' }],
    });
    expect((await h.getOrder(order.id)).body).toMatchObject({ version: 1, total: '10.0000' });
  });

  it("[FR-PO-04] an edit naming another order's line is LINE_NOT_FOUND: no line moves between orders", async () => {
    const h = await ordersHarness();
    const a = (await h.createOrder(h.orderBody([lineBody()]))).body as {
      id: string;
      lines: { id: string }[];
    };
    const b = (await h.createOrder(h.orderBody([lineBody({ quantity: 1 })]))).body as {
      id: string;
      lines: { id: string }[];
    };
    const res = await h.editOrder(
      a.id,
      h.orderBody([
        { ...lineBody(), id: a.lines[0]?.id },
        { ...lineBody(), id: b.lines[0]?.id },
      ]),
      1,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      details: [{ path: 'body.lines.1.id', code: 'LINE_NOT_FOUND' }],
    });
    expect((await h.getOrder(b.id)).body).toMatchObject({ lineCount: 1, total: '12.5000' });
  });
});

describe('[FR-PO-04] attacks through the service', () => {
  it('[FR-PO-04] a crafted input carrying a total, PO number or line total stores none of them', async () => {
    const h = await ordersHarness();
    const prisma = createPrismaClient({
      url: h.db.url('po_app'),
      poolSize: 2,
      connectionTimeoutMs: 2_000,
    });
    clients.push(prisma);
    const orders = createOrdersService({
      prisma,
      transactions: createTransactionRunner({ prisma, timeoutMs: 5_000, maxWaitMs: 2_000 }),
    });
    const parsed = createOrderBody.parse(h.orderBody([lineBody({ quantity: 2, unitPrice: '5' })]));
    const crafted = {
      ...parsed,
      total: '999.0000',
      poNumber: 'PO-2000-01-000001',
      lines: parsed.lines.map((l) => ({ ...l, lineTotal: '999.0000' })),
    } as unknown as CreateOrderBody;
    const buyer = {
      userId: h.buyer.id,
      sessionId: randomUUID(),
      name: h.buyer.name,
      email: h.buyer.email,
      roles: ['BUYER'] as const,
    };
    const { order } = await orders.createOrder(
      buyer,
      { body: crafted, idempotencyKey: randomUUID() },
      { requestId: 'req-attack', logger: testLogger(), ip: '10.0.0.1', userAgent: 'test' },
    );
    expect(order.total).toBe('10.0000');
    expect(order.poNumber).not.toBe('PO-2000-01-000001');
    expect(order.lines[0]?.lineTotal).toBe('10.0000');
  });
});
