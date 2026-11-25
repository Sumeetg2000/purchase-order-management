import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { orderFixture, readOrder, reconciliationRows, sqlstate } from '../support/orders-sql.js';
import {
  RECEIPT_EXCEEDS_ORDERED,
  approvedOrder,
  readLines,
  receive,
} from '../support/receipts-sql.js';

// Random receipt sequences (specs/007-goods-receipt/research.md R1, R2; INV-3, INV-4,
// INV-6): single- and multi-line receipts (a line once per receipt) against random
// approved orders, some over what is outstanding. After each statement every line's received quantity is the sum of its
// receipts and within 0..ordered, the open-line count matches, and the reconciliation
// returns no rows. A refused statement changes nothing. Fixed seed so a failure replays.
const SEED = 20261124;

const orders = fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 5 });
const statements = (lineCount: number) =>
  fc.array(
    fc.array(
      fc.record({
        line: fc.integer({ min: 0, max: lineCount - 1 }),
        quantity: fc.integer({ min: 1, max: 4 }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    { minLength: 1, maxLength: 6 },
  );

describe('[FR-RPT-03] receipts keep INV-3, INV-4 and INV-6 for any sequence', () => {
  it('[FR-RPT-03] random receipts, some over, never break the invariants', async () => {
    const f = await orderFixture();
    await fc.assert(
      fc.asyncProperty(
        orders.chain((quantities) =>
          fc.tuple(fc.constant(quantities), statements(quantities.length)),
        ),
        async ([quantities, sequence]) => {
          const { orderId, lineIds } = await approvedOrder(
            f,
            quantities.map((quantity) => ({ quantity, unitPrice: '1' })),
          );
          const expected = quantities.map(() => 0);
          for (const statement of sequence) {
            const asked = quantities.map(() => 0);
            for (const r of statement) asked[r.line] = (asked[r.line] ?? 0) + r.quantity;
            const over = asked.some((q, i) => (expected[i] ?? 0) + q > (quantities[i] ?? 0));
            const receipt = asked.flatMap((quantity, i) =>
              quantity > 0 ? [{ lineId: lineIds[i] ?? '', quantity }] : [],
            );
            const state = await sqlstate(() => receive(f, orderId, receipt));
            expect(state).toBe(over ? RECEIPT_EXCEEDS_ORDERED : undefined);
            if (!over) asked.forEach((q, i) => (expected[i] = (expected[i] ?? 0) + q));
            const lines = await readLines(f.app, orderId);
            expect(lines.map((l) => l.received_quantity)).toEqual(expected);
            expect(await readOrder(f.app, orderId)).toMatchObject({
              open_line_count: lines.filter((l) => l.received_quantity < l.quantity).length,
            });
          }
          expect(await reconciliationRows(f.app)).toEqual([]);
        },
      ),
      { seed: SEED, numRuns: 40 },
    );
  });
});
