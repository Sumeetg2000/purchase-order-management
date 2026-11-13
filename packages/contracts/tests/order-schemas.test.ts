import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  createOrderBody,
  deleteOrderBody,
  editOrderBody,
  fieldErrors,
  LINE_DESCRIPTION_MAX,
  ORDER_LINES_MAX,
  ORDER_READ_ONLY_FIELDS,
  ORDER_STATUSES,
  order,
  orderListItem,
  orderListQuery,
  vendorBody,
} from '../src/index.js';

// The slice 3 order schemas (contracts/api.md, research R6 and R9), reviewed before any
// service code. Failures are read through fieldErrors, the API's own issue → field code
// mapping, so these tests see exactly the details a client gets.

const VENDOR_ID = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a0b';
const LINE_ID = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a0c';

function failures(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value, { reportInput: true });
  if (result.success) return [];
  return fieldErrors('body', result.error.issues).map((e) => `${e.path} ${e.code}`);
}

const line = (extra: Record<string, unknown> = {}) => ({
  description: 'Hex bolts M8',
  quantity: 10,
  unitPrice: '12.5',
  ...extra,
});

const create = (lines: unknown[] = [line()], extra: Record<string, unknown> = {}) => ({
  vendorId: VENDOR_ID,
  lines,
  ...extra,
});

const lineFailures = (extra: Record<string, unknown>) =>
  failures(createOrderBody, create([line(extra)]));

describe('[NFR-VAL-01] order bodies', () => {
  it('[FR-PO-01] accepts 1 and 500 lines and refuses 0 and 501', () => {
    expect(failures(createOrderBody, create([line()]))).toEqual([]);
    expect(
      failures(createOrderBody, create(Array.from({ length: ORDER_LINES_MAX }, () => line()))),
    ).toEqual([]);
    expect(failures(createOrderBody, create([]))).toEqual(['body.lines TOO_SHORT']);
    expect(
      failures(createOrderBody, create(Array.from({ length: ORDER_LINES_MAX + 1 }, () => line()))),
    ).toEqual(['body.lines TOO_LONG']);
    expect(failures(createOrderBody, { lines: [line()] })).toEqual(['body.vendorId REQUIRED']);
    expect(failures(createOrderBody, create([line()], { vendorId: 'acme' }))).toEqual([
      'body.vendorId INVALID_FORMAT',
    ]);
  });

  it('[NFR-VAL-01] a description is trimmed single-line text of 1 to 500 code points', () => {
    const parsed = createOrderBody.parse(create([line({ description: '  Bolts  ' })]));
    expect(parsed.lines[0]?.description).toBe('Bolts');
    expect(lineFailures({ description: '   ' })).toEqual(['body.lines.0.description TOO_SHORT']);
    expect(lineFailures({ description: '' })).toEqual(['body.lines.0.description TOO_SHORT']);
    for (const bad of ['a\nb', 'a\tb', 'a\rb', 'a\u0000b', 'a\u0085b', 'a\u007fb']) {
      expect(lineFailures({ description: bad }), JSON.stringify(bad)).toEqual([
        'body.lines.0.description INVALID_FORMAT',
      ]);
    }
    // A lone surrogate, as an escaped JSON string can carry, is not well-formed text.
    expect(lineFailures({ description: 'a\ud83db' })).toEqual([
      'body.lines.0.description INVALID_FORMAT',
    ]);
    // Four-byte characters count once each: 500 emoji fit, 501 don't.
    expect(lineFailures({ description: '😀'.repeat(LINE_DESCRIPTION_MAX) })).toEqual([]);
    expect(lineFailures({ description: '😀'.repeat(LINE_DESCRIPTION_MAX + 1) })).toEqual([
      'body.lines.0.description TOO_LONG',
    ]);
    expect(lineFailures({ description: 'x'.repeat(LINE_DESCRIPTION_MAX + 1) })).toEqual([
      'body.lines.0.description TOO_LONG',
    ]);
    expect(lineFailures({ description: 42 })).toEqual(['body.lines.0.description INVALID_FORMAT']);
  });

  it('[NFR-VAL-01] a quantity is a whole number from 1 to 1,000,000', () => {
    expect(lineFailures({ quantity: 1 })).toEqual([]);
    expect(lineFailures({ quantity: 1_000_000 })).toEqual([]);
    expect(lineFailures({ quantity: 0 })).toEqual(['body.lines.0.quantity OUT_OF_RANGE']);
    expect(lineFailures({ quantity: -1 })).toEqual(['body.lines.0.quantity OUT_OF_RANGE']);
    expect(lineFailures({ quantity: 1_000_001 })).toEqual(['body.lines.0.quantity OUT_OF_RANGE']);
    expect(lineFailures({ quantity: 1.5 })).toEqual(['body.lines.0.quantity INVALID_FORMAT']);
    expect(lineFailures({ quantity: '5' })).toEqual(['body.lines.0.quantity INVALID_FORMAT']);
    expect(lineFailures({ quantity: undefined })).toEqual(['body.lines.0.quantity REQUIRED']);
  });

  it('[FR-PO-07] a unit price is a decimal string, 0 to 999999999.9999, at most 4 places', () => {
    const price = (unitPrice: unknown) =>
      createOrderBody.safeParse(create([line({ unitPrice })])).data?.lines[0]?.unitPrice;
    expect(price('0')).toBe('0.0000');
    expect(price('12.5')).toBe('12.5000');
    expect(price('999999999.9999')).toBe('999999999.9999');
    for (const bad of [12.5, '-1', '+1', '1e3', '12.34567', '1000000000', '1.', '.5', ' 1', '']) {
      expect(lineFailures({ unitPrice: bad }), JSON.stringify(bad)).toEqual([
        'body.lines.0.unitPrice INVALID_FORMAT',
      ]);
    }
  });

  it('[NFR-VAL-01] each derived or system-assigned field is READ_ONLY_FIELD, in the body and in a line', () => {
    for (const field of ORDER_READ_ONLY_FIELDS) {
      expect(failures(createOrderBody, create([line()], { [field]: 1 })), field).toEqual([
        `body.${field} READ_ONLY_FIELD`,
      ]);
      expect(failures(createOrderBody, create([line({ [field]: 1 })])), field).toEqual([
        `body.lines.0.${field} READ_ONLY_FIELD`,
      ]);
      expect(
        failures(editOrderBody, create([line({ id: LINE_ID, [field]: 1 })], { [field]: 1 })).sort(),
        field,
      ).toEqual([`body.${field} READ_ONLY_FIELD`, `body.lines.0.${field} READ_ONLY_FIELD`].sort());
    }
  });

  it('[NFR-VAL-01] any other extra field is UNKNOWN_FIELD, and a line id only belongs in an edit', () => {
    expect(failures(createOrderBody, create([line()], { notes: 'x' }))).toEqual([
      'body.notes UNKNOWN_FIELD',
    ]);
    expect(failures(createOrderBody, create([line({ sku: 'x' })]))).toEqual([
      'body.lines.0.sku UNKNOWN_FIELD',
    ]);
    expect(failures(createOrderBody, create([line({ id: LINE_ID })]))).toEqual([
      'body.lines.0.id UNKNOWN_FIELD',
    ]);
    expect(failures(editOrderBody, create([line({ id: LINE_ID }), line()]))).toEqual([]);
    expect(failures(editOrderBody, create([line({ id: 'line-1' })]))).toEqual([
      'body.lines.0.id INVALID_FORMAT',
    ]);
    expect(failures(editOrderBody, create([]))).toEqual(['body.lines TOO_SHORT']);
  });

  it('[NFR-VAL-01] vendors keep UNKNOWN_FIELD for an order-only key', () => {
    const vendor = {
      name: 'Acme',
      contactName: 'Ravi',
      contactEmail: 'ravi@acme.example',
      paymentTerms: { type: 'ADVANCE' },
      total: '1',
    };
    expect(failures(vendorBody, vendor)).toEqual(['body.total UNKNOWN_FIELD']);
  });

  it('[FR-SM-02] a delete reason is optional plain text of 1 to 500 code points; line breaks allowed', () => {
    expect(failures(deleteOrderBody, {})).toEqual([]);
    expect(failures(deleteOrderBody, { reason: null })).toEqual([]);
    expect(deleteOrderBody.parse({ reason: '  Duplicate\nof PO-2026-27-000001 ' }).reason).toBe(
      'Duplicate\nof PO-2026-27-000001',
    );
    expect(failures(deleteOrderBody, { reason: '' })).toEqual(['body.reason TOO_SHORT']);
    expect(failures(deleteOrderBody, { reason: '  ' })).toEqual(['body.reason TOO_SHORT']);
    expect(failures(deleteOrderBody, { reason: 'a\tb' })).toEqual(['body.reason INVALID_FORMAT']);
    expect(failures(deleteOrderBody, { reason: 'a\ud83db' })).toEqual([
      'body.reason INVALID_FORMAT',
    ]);
    expect(failures(deleteOrderBody, { reason: '😀'.repeat(500) })).toEqual([]);
    expect(failures(deleteOrderBody, { reason: '😀'.repeat(501) })).toEqual([
      'body.reason TOO_LONG',
    ]);
    expect(failures(deleteOrderBody, { reason: 'x', total: 1 })).toEqual([
      'body.total UNKNOWN_FIELD',
    ]);
  });
});

describe('[FR-PO-01] order list query and responses', () => {
  it('[FR-PO-01] filters: status, vendor, PO-number prefix (upper-cased) and an IST date range', () => {
    const parsed = orderListQuery.parse({
      status: 'DRAFT',
      vendorId: VENDOR_ID,
      poNumber: ' po-2026-27-0012 ',
      createdFrom: '2026-04-01',
      createdTo: '2026-04-30',
    });
    expect(parsed).toMatchObject({ poNumber: 'PO-2026-27-0012', page: 1, pageSize: 20 });
    expect(
      failures(orderListQuery, { createdFrom: '2026-05-01', createdTo: '2026-04-30' }),
    ).toEqual(['body.createdTo OUT_OF_RANGE']);
    expect(
      failures(orderListQuery, { createdFrom: '2026-05-01', createdTo: '2026-05-01' }),
    ).toEqual([]);
    expect(failures(orderListQuery, { status: 'SENT' })).toEqual(['body.status INVALID_FORMAT']);
    expect(failures(orderListQuery, { poNumber: 'PO 1' })).toEqual([
      'body.poNumber INVALID_FORMAT',
    ]);
    expect(failures(orderListQuery, { createdFrom: '2026-13-01' })).toEqual([
      'body.createdFrom INVALID_FORMAT',
    ]);
    expect(failures(orderListQuery, { total: '1' })).toEqual(['body.total UNKNOWN_FIELD']);
  });

  it('[FR-PO-07] responses carry money as 4-place strings, never numbers', () => {
    const base = {
      id: VENDOR_ID,
      poNumber: 'PO-2026-27-000001',
      status: ORDER_STATUSES[0],
      vendor: { id: VENDOR_ID, name: 'Acme', status: 'ACTIVE' },
      owner: { id: VENDOR_ID, name: 'Asha' },
      total: '0.3000',
      lineCount: 1,
      lines: [
        {
          id: LINE_ID,
          description: 'Bolts',
          quantity: 3,
          unitPrice: '0.1000',
          lineTotal: '0.3000',
        },
      ],
      version: 1,
      createdAt: '2026-11-12T09:00:00.000Z',
      updatedAt: '2026-11-12T09:00:00.000Z',
    };
    expect(order.safeParse(base).success).toBe(true);
    expect(order.safeParse({ ...base, total: 0.3 }).success).toBe(false);
    expect(order.safeParse({ ...base, total: '0.3' }).success).toBe(false);
    const item = Object.fromEntries(
      Object.entries(base).filter(([key]) => !['lines', 'version', 'updatedAt'].includes(key)),
    );
    expect(
      orderListItem.safeParse({ ...item, vendor: { id: VENDOR_ID, name: 'Acme' } }).success,
    ).toBe(true);
  });
});
