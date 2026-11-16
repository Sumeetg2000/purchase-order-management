import { editOrderBody, toMoney, type Order } from '@po/contracts';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createTransactionRunner, type TransactionRunner } from '../../src/db/transaction.js';
import { createOrdersService } from '../../src/orders/service.js';
import { testLogger } from '../support/log-capture.js';
import { lineBody, ordersHarness, type OrdersHarness } from '../support/orders.js';

// Editing a draft (spec US3; FR-004, FR-005, FR-020; research R6): the full intended line
// set under If-Match, lines keeping their ids, the array order as display order, one
// version step and one PO_EDITED per real change, none for a no-op.

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

async function draft(h: OrdersHarness) {
  const res = await h.createOrder(
    h.orderBody([
      lineBody({ description: 'Washers', quantity: 3, unitPrice: '0.1' }),
      lineBody({ description: 'Bolts', quantity: 7, unitPrice: '0.0125' }),
      lineBody({ description: 'Nuts', quantity: 2, unitPrice: '1' }),
    ]),
  );
  expect(res.status).toBe(201);
  return res.body as Order;
}

/** The order's lines as an edit body sends them, ids kept. */
const asSent = (order: Order) =>
  order.lines.map(({ id, description, quantity, unitPrice }) => ({
    id,
    description,
    quantity,
    unitPrice,
  }));

describe('[FR-PO-06] edit a draft', () => {
  it('[FR-PO-06] change, remove, add and move: ids kept, array order is display order, total exact, version +1', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    const [washers, , nuts] = asSent(order);
    const res = await h.editOrder(
      order.id,
      h.orderBody([
        { description: 'Spacers', quantity: 4, unitPrice: '0.25' },
        { ...washers, quantity: 10 },
        nuts,
      ]),
      1,
    );
    expect(res.status).toBe(200);
    expect(res.get('ETag')).toBe('"2"');
    const edited = res.body as Order;
    expect(edited.version).toBe(2);
    expect(edited.lines.map((l) => [l.description, l.quantity, l.lineTotal])).toEqual([
      ['Spacers', 4, '1.0000'],
      ['Washers', 10, '1.0000'],
      ['Nuts', 2, '2.0000'],
    ]);
    expect(edited.lines[1]?.id).toBe(washers?.id);
    expect(edited.lines[2]?.id).toBe(nuts?.id);
    expect(edited.lines[0]?.id).not.toBe(order.lines[1]?.id);
    expect(edited.total).toBe('4.0000');
    expect(edited.lineCount).toBe(3);
    expect((await h.getOrder(order.id)).body).toEqual(edited);
  });

  it('[NFR-AUD-01] PO_EDITED records the vendor, the lines added, removed and changed field by field, and the total', async () => {
    const h = await ordersHarness();
    const other = await h.seedVendor({ name: 'Beta Traders' });
    const order = await draft(h);
    const [washers, bolts, nuts] = asSent(order);
    const res = await h.editOrder(
      order.id,
      h.orderBody(
        [
          nuts,
          { ...washers, quantity: 10 },
          { description: 'Spacers', quantity: 4, unitPrice: '0.25' },
        ],
        {
          vendorId: other,
        },
      ),
      1,
    );
    expect(res.status).toBe(200);
    const edited = res.body as Order;
    const entries = await h.orderAudit();
    expect(entries.map((e) => e.action)).toEqual(['PO_CREATED', 'PO_EDITED']);
    const entry = entries[1];
    expect(entry).toMatchObject({
      entity_id: order.id,
      order_id: order.id,
      po_number: order.poNumber,
      acting_role: 'BUYER',
      actor_user_id: h.buyer.id,
      request_id: res.get('X-Request-Id'),
    });
    expect(entry?.details).toEqual({
      vendor: {
        before: { id: h.vendorId, name: 'Acme Supplies' },
        after: { id: other, name: 'Beta Traders' },
      },
      lines: {
        added: [
          {
            id: edited.lines[2]?.id,
            description: 'Spacers',
            quantity: 4,
            unitPrice: '0.2500',
            lineTotal: '1.0000',
          },
        ],
        removed: [
          {
            id: bolts?.id,
            description: 'Bolts',
            quantity: 7,
            unitPrice: '0.0125',
            lineTotal: '0.0875',
          },
        ],
        changed: [
          { id: nuts?.id, position: { before: 2, after: 0 } },
          {
            id: washers?.id,
            position: { before: 0, after: 1 },
            quantity: { before: 3, after: 10 },
            lineTotal: { before: '0.3000', after: '1.0000' },
          },
        ],
      },
      total: { before: '2.3875', after: '4.0000' },
    });
  });

  it('[FR-PO-06] a save that changes nothing keeps the version and writes no entry', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    // Prices sent in another form that means the same amount.
    // '0.1000' as '0.1', '1.0000' as '1'.
    const body = h.orderBody(
      asSent(order).map((l) => ({ ...l, unitPrice: l.unitPrice.replace(/\.?0+$/, '') })),
    );
    const res = await h.editOrder(order.id, body, 1);
    expect(res.status).toBe(200);
    expect(res.get('ETag')).toBe('"1"');
    expect(res.body).toEqual(order);
    expect((await h.orderAudit()).map((e) => e.action)).toEqual(['PO_CREATED']);
  });

  it('[NFR-CON-03] a stale If-Match is 409 VERSION_CONFLICT, a missing one 400 VERSION_REQUIRED; nothing changes', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    const body = h.orderBody([{ ...asSent(order)[0], quantity: 99 }]);
    expect((await h.editOrder(order.id, h.orderBody(asSent(order).slice(1)), 1)).status).toBe(200);
    const stale = await h.editOrder(order.id, body, 1);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    const missing = await h.editOrder(order.id, body, null);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      details: [{ path: 'header.if-match', code: 'VERSION_REQUIRED' }],
    });
    expect(((await h.getOrder(order.id)).body as Order).version).toBe(2);
  });

  it('[NFR-VAL-01] a line id from another order is LINE_NOT_FOUND, a repeated one DUPLICATE_LINE_ID, no lines TOO_SHORT', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    const other = await draft(h);
    const [a] = asSent(order);
    const foreign = await h.editOrder(order.id, h.orderBody([a, asSent(other)[0]]), 1);
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({
      details: [{ path: 'body.lines.1.id', code: 'LINE_NOT_FOUND' }],
    });
    const twice = await h.editOrder(order.id, h.orderBody([a, a]), 1);
    expect(twice.body).toMatchObject({
      details: [{ path: 'body.lines.1.id', code: 'DUPLICATE_LINE_ID' }],
    });
    const empty = await h.editOrder(order.id, h.orderBody([]), 1);
    expect(empty.body).toMatchObject({ details: [{ path: 'body.lines', code: 'TOO_SHORT' }] });
    expect(((await h.getOrder(order.id)).body as Order).version).toBe(1);
  });

  it('[FR-VEN-02] a missing vendor is 400 VENDOR_NOT_FOUND; an inactive one 409; a draft whose vendor was deactivated may move to an active one', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    const missing = await h.editOrder(
      order.id,
      h.orderBody(asSent(order), { vendorId: UNKNOWN_ID }),
      1,
    );
    expect(missing.body).toMatchObject({
      details: [{ path: 'body.vendorId', code: 'VENDOR_NOT_FOUND' }],
    });
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(`UPDATE vendors SET status = 'INACTIVE', deactivated_at = now() WHERE id = $1`, [
      h.vendorId,
    ]);
    await h.query('COMMIT');
    const same = await h.editOrder(order.id, h.orderBody(asSent(order)), 1);
    expect(same.status).toBe(409);
    expect(same.body).toMatchObject({ code: 'VENDOR_INACTIVE' });
    const active = await h.seedVendor({ name: 'Beta Traders' });
    const moved = await h.editOrder(order.id, h.orderBody(asSent(order), { vendorId: active }), 1);
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      vendor: { id: active, name: 'Beta Traders', status: 'ACTIVE' },
    });
  });

  it('[FR-OWN-01] another Buyer, or an id that is unknown or malformed, never reaches the order', async () => {
    const h = await ordersHarness();
    const order = await draft(h);
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));
    const body = h.orderBody(asSent(order));
    expect((await h.editOrder(order.id, body, 1, other)).status).toBe(404);
    expect((await h.editOrder(UNKNOWN_ID, body, 1)).status).toBe(404);
    const malformed = await h.editOrder('not-a-uuid', body, 1);
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      details: [{ path: 'path.id', code: 'INVALID_FORMAT' }],
    });
  });
});

describe("[NFR-PERF-03] an edit's line statements", () => {
  const clients: AppPrismaClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
  });

  it('[NFR-PERF-03] a 300-line edit that adds, changes and removes lines runs one INSERT, one UPDATE and one DELETE on lines', async () => {
    const h = await ordersHarness();
    const created = await h.createOrder(
      h.orderBody(
        Array.from({ length: 300 }, (_, i) => lineBody({ description: `Line ${String(i)}` })),
      ),
    );
    const order = created.body as Order;
    const prisma = createPrismaClient({
      url: h.db.url('po_app'),
      poolSize: 2,
      connectionTimeoutMs: 2_000,
    });
    clients.push(prisma);
    const statements: string[] = [];
    const real = createTransactionRunner({ prisma, timeoutMs: 10_000, maxWaitMs: 2_000 });
    // Records the first words of every statement the service sends in its transaction.
    const transactions: TransactionRunner = {
      run: (context, fn) =>
        real.run(context, (tx, hooks) => {
          const counted = new Proxy(tx, {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver) as unknown;
              if (
                (property === '$executeRaw' || property === '$queryRaw') &&
                typeof value === 'function'
              ) {
                return (strings: TemplateStringsArray, ...values: unknown[]) => {
                  statements.push(strings.join('?').trim().replace(/\s+/g, ' ').slice(0, 40));
                  return (value as (...a: unknown[]) => unknown).apply(target, [
                    strings,
                    ...values,
                  ]);
                };
              }
              return value;
            },
          });
          return fn(counted, hooks);
        }),
    };
    const orders = createOrdersService({ prisma, transactions });
    const lines = asSent(order);
    const intended = [
      { description: 'New A', quantity: 1, unitPrice: '1' },
      ...lines.slice(0, 200).map((l) => ({ ...l, quantity: 2 })),
      { description: 'New B', quantity: 1, unitPrice: '1' },
    ];
    const body = editOrderBody.parse(h.orderBody(intended));
    const edited = await orders.editOrder(
      {
        userId: h.buyer.id,
        sessionId: randomUUID(),
        name: h.buyer.name,
        email: h.buyer.email,
        roles: ['BUYER'],
      },
      { id: order.id, version: 1, body },
      { requestId: 'req-edit', logger: testLogger(), ip: '10.0.0.1', userAgent: 'test' },
    );
    expect(edited.lineCount).toBe(202);
    expect(edited.total).toBe(toMoney('5002'));
    const lineWrites = statements.filter((s) =>
      /^(INSERT INTO|UPDATE|DELETE FROM) order_lines/.test(s),
    );
    expect(lineWrites.map((s) => s.split(' ')[0])).toEqual(['INSERT', 'UPDATE', 'DELETE']);
  });
});
