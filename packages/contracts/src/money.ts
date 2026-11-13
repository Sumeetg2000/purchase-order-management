import Big from 'big.js';
import { z } from 'zod';

// Exact money (ADR-0010, slice 3 research R1). The API and the web app share this module:
// amounts are decimal strings with 4 places, added and multiplied by big.js, which is
// exact for both whatever its precision setting. Big never leaves this module.

/** A constructor of our own, so no other big.js user can change its settings. */
const Decimal = Big();
/** A JavaScript number passed to Decimal throws: no float ever becomes money. */
Decimal.strict = true;

export const MONEY_SCALE = 4;
/** Every amount in a response: up to 18 digits, a point and exactly 4 places. */
export const MONEY_PATTERN = /^\d{1,18}\.\d{4}$/;
/** A unit price as a client sends it: up to 9 digits and up to 4 places, no sign. */
export const UNIT_PRICE_INPUT_PATTERN = /^\d{1,9}(\.\d{1,4})?$/;
/** Any non-negative decimal toMoney can read: digits, then optionally a point and digits. */
const DECIMAL_INPUT = /^\d+(\.\d+)?$/;

export const money = z.string().regex(MONEY_PATTERN).brand<'Money'>().meta({ id: 'Money' });
export type Money = z.infer<typeof money>;

function asMoney(value: InstanceType<typeof Decimal>): Money {
  const text = value.toFixed(MONEY_SCALE);
  if (!MONEY_PATTERN.test(text)) throw new RangeError(`${text} is not a money amount`);
  return text as Money;
}

/**
 * A non-negative decimal string as Money, with exactly 4 places. Refuses anything that
 * isn't such a string, and any value 4 places can't hold exactly (no rounding).
 */
export function toMoney(value: string): Money {
  if (typeof value !== 'string' || !DECIMAL_INPUT.test(value)) {
    throw new TypeError(`${JSON.stringify(value)} is not a decimal string`);
  }
  const amount = new Decimal(value);
  const result = asMoney(amount);
  if (!new Decimal(result).eq(amount)) {
    throw new RangeError(`${value} has more than ${String(MONEY_SCALE)} decimal places`);
  }
  return result;
}

/** quantity × unit price, exactly. The quantity is a non-negative whole number. */
export function lineTotal(quantity: number, unitPrice: Money): Money {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(`${String(quantity)} is not a whole quantity`);
  }
  return asMoney(new Decimal(String(quantity)).times(new Decimal(unitPrice)));
}

/** The exact sum; 0.0000 for none. */
export function sum(values: readonly Money[]): Money {
  return asMoney(values.reduce((acc, v) => acc.plus(new Decimal(v)), new Decimal('0')));
}

/**
 * An amount in rupees with Indian digit grouping (12,34,567) and 2 to 4 decimal places:
 * trailing zeros after the second place are dropped. Built from the digits, never a float.
 */
export function formatInr(value: Money): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+$)/g, ',')},${lastThree}` : lastThree;
  const places = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `₹${grouped}.${places}`;
}
