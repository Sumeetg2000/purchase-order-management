import {
  createOrderBody,
  IDEMPOTENCY_KEY_TTL_HOURS,
  LINE_DESCRIPTION_MAX,
  LINE_QUANTITY_MAX,
  ORDER_LINES_MAX,
  ORDER_STATUSES,
  PO_NUMBER_PATTERN,
  PO_NUMBER_TIME_ZONE,
  UNIT_PRICE_MAX,
} from '@po/contracts';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { inTransaction, orderFixture, sqlstate, type OrderFixture } from '../support/orders-sql.js';

// Every order constant's SQL copy in migration 0013 equals the constant (CLAUDE.md), and
// the API's description rule and the database's agree on the same samples (research R9).

async function constraintDef(q: pg.Client, name: string): Promise<string> {
  const { rows } = await q.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  return rows[0]?.def ?? '';
}

/** Whether the database stores `description` on a line (the CHECK alone decides). */
async function databaseAccepts(f: OrderFixture, description: string): Promise<boolean> {
  const state = await sqlstate(() =>
    inTransaction(f.app, async (q) => {
      const orderId = randomUUID();
      await q.query(`INSERT INTO purchase_orders (id, owner_id, vendor_id) VALUES ($1, $2, $3)`, [
        orderId,
        f.buyerId,
        f.vendorId,
      ]);
      await q.query(
        `INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price)
         VALUES (gen_random_uuid(), $1, 0, $2, 1, 1)`,
        [orderId, description],
      );
      throw Object.assign(new Error('rollback'), { code: 'STORED' });
    }),
  );
  if (state !== 'STORED' && state !== '23514') throw new Error(`unexpected ${String(state)}`);
  return state === 'STORED';
}

/** The description the API would store (trimmed), or undefined if it refuses it. */
function apiStores(description: string): string | undefined {
  const parsed = createOrderBody.safeParse({
    vendorId: randomUUID(),
    lines: [{ description, quantity: 1, unitPrice: '1' }],
  });
  return parsed.success ? parsed.data.lines[0]?.description : undefined;
}

describe('[FR-PO-01] order constants equal their SQL copies (0013)', () => {
  it('[FR-PO-01] line counts, description length, quantity and unit price', async () => {
    const { superuser: q } = await orderFixture();
    expect(await constraintDef(q, 'order_lines_position_range')).toBe(
      `CHECK ((("position" >= 0) AND ("position" <= ${String(ORDER_LINES_MAX - 1)})))`,
    );
    expect(await constraintDef(q, 'order_lines_description_valid')).toContain(
      `((char_length(description) >= 1) AND (char_length(description) <= ${String(LINE_DESCRIPTION_MAX)}))`,
    );
    expect(await constraintDef(q, 'order_lines_quantity_range')).toBe(
      `CHECK (((quantity >= 1) AND (quantity <= ${String(LINE_QUANTITY_MAX)})))`,
    );
    // numeric(13,4) holds exactly UNIT_PRICE_MAX and nothing above it.
    const { rows } = await q.query<{ max: string; scale: number; precision: number }>(
      `SELECT numeric_precision AS precision, numeric_scale AS scale,
              (repeat('9', numeric_precision - numeric_scale) || '.' || repeat('9', numeric_scale)) AS max
         FROM information_schema.columns
        WHERE table_name = 'order_lines' AND column_name = 'unit_price'`,
    );
    expect(rows[0]?.max).toBe(UNIT_PRICE_MAX);
  });

  it('[FR-PO-01] statuses, the PO number format and the idempotency operation', async () => {
    const { superuser: q } = await orderFixture();
    const statuses = [
      ...(await constraintDef(q, 'purchase_orders_status_valid')).matchAll(/'([^']+)'::text/g),
    ].map(([, value]) => value);
    expect(statuses).toEqual([...ORDER_STATUSES]);
    expect(await constraintDef(q, 'purchase_orders_po_number_format')).toBe(
      `CHECK ((po_number ~ '${PO_NUMBER_PATTERN.source}'::text))`,
    );
    expect(await constraintDef(q, 'idempotency_keys_operation_valid')).toBe(
      `CHECK ((operation = 'createOrder'::text))`,
    );
  });

  it('[FR-PO-05] po_financial_year uses PO_NUMBER_TIME_ZONE', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ def: string }>(
      `SELECT pg_get_functiondef('po_financial_year'::regproc) AS def`,
    );
    const zones = [...(rows[0]?.def ?? '').matchAll(/AT TIME ZONE '([^']+)'/g)].map(([, z]) => z);
    expect(zones.length).toBeGreaterThan(0);
    expect(new Set(zones)).toEqual(new Set([PO_NUMBER_TIME_ZONE]));
  });

  it('[NFR-CON-01] the idempotency key lifetime is a whole number of hours', () => {
    // The purge reads the constant directly (maintenance/purge.ts); no SQL copy exists.
    expect(Number.isInteger(IDEMPOTENCY_KEY_TTL_HOURS)).toBe(true);
    expect(IDEMPOTENCY_KEY_TTL_HOURS).toBe(24);
  });

  it('[NFR-VAL-01] the API and the database accept and refuse the same descriptions', async () => {
    const f = await orderFixture();
    const samples: Record<string, string> = {
      plain: 'Hex bolts M8',
      emoji: '😀 bolts',
      'emoji × 500': '😀'.repeat(LINE_DESCRIPTION_MAX),
      'emoji × 501': '😀'.repeat(LINE_DESCRIPTION_MAX + 1),
      'no-break space inside': 'Hex bolts',
      'zero-width space': 'Hex​bolts',
      'line separator U+2028': 'Hex bolts',
      'paragraph separator U+2029': 'Hex bolts',
      'combining accent': 'Café',
      tab: 'Hex\tbolts',
      'line feed': 'Hex\nbolts',
      'carriage return': 'Hex\rbolts',
      'U+0001': 'Hex\u0001bolts',
      DEL: 'Hex\u007fbolts',
      'NEL U+0085': 'Hex\u0085bolts',
      'U+009F': 'Hex\u009fbolts',
      'U+00A0 alone at the end': 'Hex ',
      'leading space': ' Hex',
      empty: '',
    };
    const disagreements: string[] = [];
    // What the API accepts, the database stores; what the API refuses, the database refuses.
    for (const [name, value] of Object.entries(samples)) {
      const stored = apiStores(value);
      const db = await databaseAccepts(f, stored ?? value);
      if ((stored !== undefined) !== db) {
        disagreements.push(
          `${name}: API ${stored === undefined ? 'refuses' : 'accepts'}, database ${db ? 'accepts' : 'refuses'}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });
});
