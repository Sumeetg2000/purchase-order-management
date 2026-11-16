import { lineTotal, sum, toMoney, type Order } from '@po/contracts';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { createOrdersService } from '../../src/orders/service.js';
import { lineBody, ordersHarness } from '../support/orders.js';

// An order is read in one statement (one snapshot): its version (the ETag), its lines and
// its total always belong to the same committed state. Two reads on two connections could
// pair a new version with old lines, and an edit sent with that ETag would silently
// replace lines the user never saw (a lost update between two tabs).

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

async function setup() {
  const h = await ordersHarness();
  const created = await h.createOrder(
    h.orderBody([
      lineBody({ quantity: 1, unitPrice: '0.1' }),
      lineBody({ quantity: 1, unitPrice: '2.5' }),
    ]),
  );
  const orderId = (created.body as { id: string }).id;
  const prisma = createPrismaClient({
    url: h.db.url('po_app'),
    poolSize: 8,
    connectionTimeoutMs: 5_000,
  });
  clients.push(prisma);
  let queries = 0;
  // Counts the statements the service sends.
  const counted = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === '$queryRaw' || property === '$queryRawUnsafe') {
        return (...args: unknown[]) => {
          queries += 1;
          const method = Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown;
          return method.apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const orders = createOrdersService({
    prisma: counted,
    transactions: createTransactionRunner({ prisma, timeoutMs: 5_000, maxWaitMs: 5_000 }),
  });
  const user = {
    userId: h.buyer.id,
    sessionId: randomUUID(),
    name: h.buyer.name,
    email: h.buyer.email,
    roles: ['BUYER'] as const,
  };
  return { h, orderId, orders, user, queries: () => queries };
}

/** Each line's quantity is the version, so a read pairing two states shows it. */
function consistent(order: Order): boolean {
  return (
    order.lines.every((l) => l.quantity === order.version) &&
    order.total === sum(order.lines.map((l) => lineTotal(l.quantity, toMoney(l.unitPrice))))
  );
}

describe('[NFR-CON-03] reading an order', () => {
  it('[NFR-CON-03] an order, its lines and total are read in one statement', async () => {
    const { orderId, orders, user, queries } = await setup();
    const before = queries();
    const order = await orders.getOrder(user, orderId);
    expect(queries() - before).toBe(1);
    expect(order.lines.map((l) => l.unitPrice)).toEqual(['0.1000', '2.5000']);
    expect(order.total).toBe('2.6000');
  });

  it('[NFR-CON-03] the version, the lines and the total always come from the same commit', async () => {
    const { h, orderId, orders, user } = await setup();
    const writer = await h.db.client('po_app');
    let writing = true;
    const writes = (async () => {
      for (let version = 2; version <= 60; version += 1) {
        await writer.query('BEGIN');
        await writer.query(`SELECT set_config('app.actor_txid', txid_current()::text, true)`);
        await writer.query(`SELECT set_config('app.actor_type', 'SYSTEM', true)`);
        await writer.query(`UPDATE order_lines SET quantity = $2 WHERE order_id = $1`, [
          orderId,
          version,
        ]);
        await writer.query(`UPDATE purchase_orders SET version = $2 WHERE id = $1`, [
          orderId,
          version,
        ]);
        await writer.query('COMMIT');
      }
      writing = false;
    })();
    const torn: Order[] = [];
    const reads = Array.from({ length: 4 }, async () => {
      while (writing) {
        const order = await orders.getOrder(user, orderId);
        if (order.version > 1 && !consistent(order)) torn.push(order);
      }
    });
    await Promise.all([writes, ...reads]);
    expect(torn).toEqual([]);
  });
});
