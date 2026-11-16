import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatInr,
  lineTotal,
  LINE_QUANTITY_MAX,
  money,
  MONEY_PATTERN,
  sum,
  toMoney,
  UNIT_PRICE_INPUT_PATTERN,
  type Money,
} from '../src/index.js';

// The money module (research R1) against an independent oracle: integers scaled by 10⁴ in
// BigInt, which is exact by construction. Fixed seed so a CI failure replays locally; on
// failure fast-check prints the seed and the shrunk counterexample.
const SEED = 20261112;
const RUNS = { seed: SEED, numRuns: 1000 };

const SCALE = 10_000n;

/** "12.5" → 125000n (scaled by 10⁴). Accepts at most 4 decimal places. */
function scaled(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
}

/** 125000n → "12.5000". */
function unscaled(value: bigint): string {
  return `${String(value / SCALE)}.${String(value % SCALE).padStart(4, '0')}`;
}

const quantities = fc.integer({ min: 1, max: LINE_QUANTITY_MAX });
const unitPrices = fc.stringMatching(UNIT_PRICE_INPUT_PATTERN);
const lineTotals = fc.tuple(quantities, unitPrices).map(([q, p]) => lineTotal(q, toMoney(p)));

describe('[NFR-DATA-01] money: exact decimals, property-based', () => {
  it('[NFR-DATA-01] toMoney normalises any unit price input to 4 places, exactly and idempotently', () => {
    fc.assert(
      fc.property(unitPrices, (price) => {
        const normalised = toMoney(price);
        expect(normalised).toMatch(MONEY_PATTERN);
        expect(scaled(normalised)).toBe(scaled(price));
        expect(toMoney(normalised)).toBe(normalised);
        expect(money.safeParse(normalised).success).toBe(true);
      }),
      RUNS,
    );
  });

  it('[FR-PO-07] lineTotal equals quantity × unit price, exactly, for every valid input', () => {
    fc.assert(
      fc.property(quantities, unitPrices, (quantity, price) => {
        const total = lineTotal(quantity, toMoney(price));
        expect(total).toMatch(MONEY_PATTERN);
        expect(total).toBe(unscaled(BigInt(quantity) * scaled(price)));
      }),
      RUNS,
    );
  });

  it('[FR-PO-07] sum equals the exact sum of 1 to 500 line totals', () => {
    fc.assert(
      fc.property(fc.array(lineTotals, { minLength: 1, maxLength: 500 }), (totals) => {
        const expected = unscaled(totals.reduce((acc, t) => acc + scaled(t), 0n));
        expect(sum(totals)).toBe(expected);
        expect(sum(totals)).toMatch(MONEY_PATTERN);
      }),
      { ...RUNS, numRuns: 200 },
    );
  });

  it('[FR-PO-07] sum is commutative and associative', () => {
    fc.assert(
      fc.property(
        fc.array(lineTotals, { minLength: 1, maxLength: 50 }),
        fc.nat(),
        (totals, cut) => {
          const at = cut % (totals.length + 1);
          const reversed = [...totals].reverse();
          expect(sum(reversed)).toBe(sum(totals));
          expect(sum([sum(totals.slice(0, at)), sum(totals.slice(at))])).toBe(sum(totals));
        },
      ),
      RUNS,
    );
  });

  it('[NFR-DATA-01] formatInr groups digits the Indian way, keeps every digit and 2 to 4 places', () => {
    const grouped = /^₹(\d{1,3}|\d{1,2}(,\d{2})*,\d{3})\.\d{2,4}$/;
    fc.assert(
      fc.property(lineTotals, (value) => {
        const shown = formatInr(value);
        expect(shown).toMatch(grouped);
        expect(scaled(shown.slice(1).replaceAll(',', ''))).toBe(scaled(value));
      }),
      RUNS,
    );
  });

  it('[NFR-DATA-01] formatInr agrees with Intl en-IN, which formats the decimal string exactly', () => {
    const intl = new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
    fc.assert(
      fc.property(lineTotals, (value) => {
        // Intl takes a decimal string without rounding through a float.
        expect(formatInr(value)).toBe(
          `₹${intl.format(value as unknown as Parameters<typeof intl.format>[0])}`,
        );
      }),
      RUNS,
    );
  });
});

describe('[FR-PO-07] money: examples and limits', () => {
  it('[FR-PO-07] 0.1 × 1 three times is exactly 0.3000, and 7 × 0.0125 is 0.0875', () => {
    const tenth = lineTotal(1, toMoney('0.1'));
    expect(sum([tenth, tenth, tenth])).toBe('0.3000');
    expect(lineTotal(7, toMoney('0.0125'))).toBe('0.0875');
  });

  it('[FR-PO-07] the largest order total fits: 500 × 1,000,000 × 999,999,999.9999', () => {
    const line = lineTotal(LINE_QUANTITY_MAX, toMoney('999999999.9999'));
    expect(line).toBe('999999999999900.0000');
    expect(sum(Array.from({ length: 500 }, () => line))).toBe('499999999999950000.0000');
  });

  it('[FR-PO-07] formats amounts in INR with Indian grouping', () => {
    expect(formatInr(toMoney('0.3'))).toBe('₹0.30');
    expect(formatInr(toMoney('1234567.0125'))).toBe('₹12,34,567.0125');
    expect(formatInr(toMoney('100000'))).toBe('₹1,00,000.00');
    expect(formatInr(toMoney('999.5'))).toBe('₹999.50');
  });

  it('[NFR-DATA-01] refuses a JavaScript number, and input it cannot represent exactly', () => {
    expect(() => toMoney(0.1 as unknown as string)).toThrow();
    expect(() => lineTotal(1.5, toMoney('1'))).toThrow();
    expect(() => lineTotal(-1, toMoney('1'))).toThrow();
    expect(() => toMoney('0.12345')).toThrow();
    expect(() => toMoney('-1')).toThrow();
    expect(() => toMoney('1e3')).toThrow();
    expect(() => toMoney('')).toThrow();
  });

  it('[NFR-DATA-01] the Money schema accepts only 4-place decimal strings', () => {
    expect(money.safeParse('0.3000').success).toBe(true);
    expect(money.safeParse('0.3').success).toBe(false);
    expect(money.safeParse(0.3).success).toBe(false);
    expect(money.safeParse('-1.0000').success).toBe(false);
    const branded: Money = toMoney('1');
    expect(branded).toBe('1.0000');
  });
});
