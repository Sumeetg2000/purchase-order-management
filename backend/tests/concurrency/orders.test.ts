import { PO_NUMBER_PATTERN, type Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { lineBody, ordersHarness } from '../support/orders.js';

// Orders under concurrent requests (Principle V, SC-004): two edits of one draft at the
// same version end with one success and one VERSION_CONFLICT; concurrent creates get
// distinct, consecutive PO numbers. The shared afterEach reconciles the database.

describe('[NFR-CON-03] concurrent order requests', () => {
  it("[NFR-CON-03] two edits sent with the same version: one 200, one 409, and the winner's lines stored", async () => {
    const h = await ordersHarness();
    const created = await h.createOrder(h.orderBody([lineBody({ quantity: 1 })]));
    const order = created.body as Order;
    const line = order.lines[0];
    const edit = (quantity: number) =>
      h.editOrder(
        order.id,
        h.orderBody([{ id: line?.id, description: line?.description, quantity, unitPrice: '1' }]),
        1,
      );
    const results = await Promise.all([edit(2), edit(3)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)?.body as Order;
    const stored = (await h.getOrder(order.id)).body as Order;
    expect(stored).toEqual(winner);
    expect(stored.version).toBe(2);
  });

  it('[FR-PO-05] 50 concurrent creates get 50 distinct, consecutive PO numbers', async () => {
    const h = await ordersHarness();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => h.createOrder(h.orderBody([lineBody()]))),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => (r.body as Order).poNumber);
    numbers.forEach((n) => {
      expect(n).toMatch(PO_NUMBER_PATTERN);
    });
    const seqs = numbers.map((n) => Number(n.split('-').at(-1))).sort((a, b) => a - b);
    const first = seqs[0] ?? 0;
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => first + i));
  });
});
