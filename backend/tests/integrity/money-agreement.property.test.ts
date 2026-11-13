import {
  lineTotal,
  LINE_QUANTITY_MAX,
  ORDER_LINES_MAX,
  sum,
  toMoney,
  UNIT_PRICE_INPUT_PATTERN,
  UNIT_PRICE_MAX,
} from '@po/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createDraft, orderFixture } from '../support/orders-sql.js';

// PostgreSQL and the shared money module agree exactly (US2 scenario 4, ADR-0010): random
// orders of 1 to 500 lines with fractional prices and limit values are stored by raw SQL,
// and the database's line totals and order total, read as text, equal what money.ts
// computes. Fixed seed so a CI failure replays; fast-check prints the shrunk order.
const SEED = 20261112;

const quantities = fc.oneof(
  fc.integer({ min: 1, max: LINE_QUANTITY_MAX }),
  fc.constantFrom(1, LINE_QUANTITY_MAX),
);
const prices = fc.oneof(
  fc.stringMatching(UNIT_PRICE_INPUT_PATTERN),
  fc.constantFrom('0', '0.0001', '0.1', UNIT_PRICE_MAX),
);
const orderLines = fc.array(fc.record({ quantity: quantities, unitPrice: prices }), {
  minLength: 1,
  maxLength: ORDER_LINES_MAX,
});

describe('[NFR-DATA-01] the database and money.ts compute the same exact totals', () => {
  it('[NFR-DATA-01] for random orders of up to 500 lines at and inside the limits', async () => {
    const f = await orderFixture();
    await fc.assert(
      fc.asyncProperty(orderLines, async (lines) => {
        const { orderId } = await createDraft(f, lines);
        const { rows } = await f.app.query<{ line_total: string; total: string }>(
          `SELECT l.line_total::text AS line_total, o.total::text AS total
             FROM order_lines l JOIN purchase_orders o ON o.id = l.order_id
            WHERE o.id = $1 ORDER BY l.position`,
          [orderId],
        );
        const expected = lines.map((l) => lineTotal(l.quantity, toMoney(l.unitPrice)));
        expect(rows.map((r) => r.line_total)).toEqual(expected);
        expect(rows[0]?.total).toBe(sum(expected));
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});
