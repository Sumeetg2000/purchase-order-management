import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  fieldErrors,
  ORDER_LINES_MAX,
  RECEIPT_NOTE_MAX,
  RECEIPT_READ_ONLY_FIELDS,
  receiptDetail,
  receiptPage,
  receiptSummary,
  recordedReceipt,
  recordReceiptBody,
} from '../src/index.js';

// The slice 6 receipt schemas (specs/007-goods-receipt/contracts/api.md, research R1, R7),
// reviewed before any service code. Failures are read through fieldErrors, the API's own
// issue → field code mapping, so these tests see exactly the details a client gets.

const LINE_A = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a0c';
const LINE_B = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a0d';
const RECEIPT_ID = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a10';
const USER_ID = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a11';

function failures(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value, { reportInput: true });
  if (result.success) return [];
  return fieldErrors('body', result.error.issues).map((e) => `${e.path} ${e.code}`);
}

const body = (extra: Record<string, unknown> = {}) => ({
  receivedOn: '2026-11-24',
  lines: [{ lineId: LINE_A, quantity: 40 }],
  ...extra,
});

const lineIds = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    lineId: `0192f0c4-1c2d-7e3f-8a4b-${i.toString(16).padStart(12, '0')}`,
    quantity: 1,
  }));

describe('[NFR-VAL-01] the receipt body', () => {
  it('[FR-RCV-01] accepts a receipt date, an optional note and 1 to 500 lines', () => {
    expect(failures(recordReceiptBody, body())).toEqual([]);
    expect(failures(recordReceiptBody, body({ note: null }))).toEqual([]);
    expect(
      failures(recordReceiptBody, body({ note: 'Two boxes dented\nSigned by stores' })),
    ).toEqual([]);
    expect(failures(recordReceiptBody, body({ lines: lineIds(ORDER_LINES_MAX) }))).toEqual([]);
    expect(failures(recordReceiptBody, body({ lines: [] }))).toEqual(['body.lines TOO_SHORT']);
    expect(failures(recordReceiptBody, body({ lines: lineIds(ORDER_LINES_MAX + 1) }))).toEqual([
      'body.lines TOO_LONG',
    ]);
  });

  it('[FR-RCV-01] the receipt date is receivedOn, a calendar date YYYY-MM-DD', () => {
    expect(failures(recordReceiptBody, { lines: body().lines })).toEqual([
      'body.receivedOn REQUIRED',
    ]);
    for (const receivedOn of ['24-11-2026', '2026-11-24T10:00:00Z', '2026-02-30', '']) {
      expect(failures(recordReceiptBody, body({ receivedOn })), receivedOn).toEqual([
        'body.receivedOn INVALID_FORMAT',
      ]);
    }
    // The old name is not accepted.
    expect(
      failures(recordReceiptBody, { receivedAt: '2026-11-24', lines: body().lines }).sort(),
    ).toEqual(['body.receivedAt UNKNOWN_FIELD', 'body.receivedOn REQUIRED']);
  });

  it('[NFR-VAL-01] a quantity is a whole number from 1 to 1,000,000', () => {
    const quantity = (q: unknown) =>
      failures(recordReceiptBody, body({ lines: [{ lineId: LINE_A, quantity: q }] }));
    expect(quantity(1)).toEqual([]);
    expect(quantity(1_000_000)).toEqual([]);
    expect(quantity(0)).toEqual(['body.lines.0.quantity OUT_OF_RANGE']);
    expect(quantity(-1)).toEqual(['body.lines.0.quantity OUT_OF_RANGE']);
    expect(quantity(1_000_001)).toEqual(['body.lines.0.quantity OUT_OF_RANGE']);
    expect(quantity(1.5)).toEqual(['body.lines.0.quantity INVALID_FORMAT']);
    expect(quantity('3')).toEqual(['body.lines.0.quantity INVALID_FORMAT']);
  });

  it('[FR-RCV-01] the same line twice is DUPLICATE_LINE_ID on the later entry', () => {
    expect(
      failures(
        recordReceiptBody,
        body({
          lines: [
            { lineId: LINE_A, quantity: 1 },
            { lineId: LINE_B, quantity: 1 },
            { lineId: LINE_A, quantity: 2 },
          ],
        }),
      ),
    ).toEqual(['body.lines.2.lineId DUPLICATE_LINE_ID']);
    expect(failures(recordReceiptBody, body({ lines: [{ lineId: 'x', quantity: 1 }] }))).toEqual([
      'body.lines.0.lineId INVALID_FORMAT',
    ]);
  });

  it('[NFR-VAL-01] the note is trimmed plain text of at most 500 characters, line breaks allowed', () => {
    const note = (value: unknown) => failures(recordReceiptBody, body({ note: value }));
    expect(note('x'.repeat(RECEIPT_NOTE_MAX))).toEqual([]);
    expect(note('😀'.repeat(RECEIPT_NOTE_MAX))).toEqual([]);
    expect(note(`  ${'x'.repeat(RECEIPT_NOTE_MAX)}  `)).toEqual([]);
    expect(note('x'.repeat(RECEIPT_NOTE_MAX + 1))).toEqual(['body.note TOO_LONG']);
    expect(note('   ')).toEqual(['body.note TOO_SHORT']);
    expect(note('Tab\there')).toEqual(['body.note INVALID_FORMAT']);
    expect(recordReceiptBody.parse(body({ note: '  Dented  ' })).note).toBe('Dented');
  });

  it('[NFR-VAL-01] is strict: an unknown field is UNKNOWN_FIELD, a derived one READ_ONLY_FIELD', () => {
    expect(failures(recordReceiptBody, body({ vendorId: LINE_A }))).toEqual([
      'body.vendorId UNKNOWN_FIELD',
    ]);
    for (const field of RECEIPT_READ_ONLY_FIELDS) {
      expect(failures(recordReceiptBody, body({ [field]: 1 })), field).toEqual([
        `body.${field} READ_ONLY_FIELD`,
      ]);
      expect(
        failures(recordReceiptBody, body({ lines: [{ lineId: LINE_A, quantity: 1, [field]: 1 }] })),
        `line ${field}`,
      ).toEqual([`body.lines.0.${field} READ_ONLY_FIELD`]);
    }
    expect([...RECEIPT_READ_ONLY_FIELDS].sort()).toEqual(
      [
        'id',
        'lineCount',
        'outstandingAfter',
        'position',
        'receiptProgress',
        'receivedAfter',
        'receivedBefore',
        'recordedAt',
        'recordedBy',
      ].sort(),
    );
  });
});

describe('[FR-RCV-03] receipt responses', () => {
  const recordedBy = { id: USER_ID, name: 'Asha Rao' };
  const head = {
    id: RECEIPT_ID,
    receivedOn: '2026-11-24',
    recordedAt: '2026-11-24T05:30:00.000Z',
    note: null,
  };

  it('[FR-RCV-01] the recorded receipt: the receipt, its lines before and after, the progress', () => {
    const value = {
      ...head,
      receiptProgress: 'PARTIALLY_RECEIVED',
      lines: [
        {
          lineId: LINE_A,
          position: 0,
          quantity: 40,
          receivedBefore: 0,
          receivedAfter: 40,
          outstandingAfter: 60,
        },
      ],
    };
    expect(recordedReceipt.safeParse(value).success).toBe(true);
    expect(recordedReceipt.safeParse({ ...value, receiptProgress: 'DONE' }).success).toBe(false);
    expect(recordedReceipt.safeParse({ ...value, receivedAt: '2026-11-24' }).success).toBe(false);
  });

  it('[FR-RCV-03] a history page holds receipt summaries with a line count, never lines', () => {
    const summary = { ...head, recordedBy, lineCount: 3 };
    expect(receiptSummary.safeParse(summary).success).toBe(true);
    expect(receiptSummary.safeParse({ ...summary, lines: [] }).success).toBe(false);
    expect(
      receiptPage.safeParse({ items: [summary], page: 1, pageSize: 20, total: 1 }).success,
    ).toBe(true);
  });

  it("[FR-RCV-03] one receipt's detail holds its lines with their order line", () => {
    const detail = {
      ...head,
      recordedBy,
      lines: [{ line: { id: LINE_A, position: 0, description: 'Hex bolts M8' }, quantity: 40 }],
    };
    expect(receiptDetail.safeParse(detail).success).toBe(true);
    expect(receiptDetail.safeParse({ ...detail, lineCount: 1 }).success).toBe(false);
  });
});
