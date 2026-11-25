import { z } from 'zod';
import { ORDER_LINES_MAX, ORDER_LINES_MIN } from '../orders.js';
import {
  RECEIPT_NOTE_MAX,
  RECEIPT_PROGRESS,
  RECEIPT_QUANTITY_MAX,
  RECEIPT_QUANTITY_MIN,
  RECEIPT_READ_ONLY_FIELDS,
} from '../receipts.js';
import { pageOf } from './pagination.js';
import { readOnlyGuarded } from './read-only.js';
import { plainText } from './text.js';

// Goods receipt (specs/007-goods-receipt/contracts/api.md, research R1, R7): a receipt is
// a document, one per delivery, with a line per order line it covers. Positions count
// from 0, as stored; the web app shows position + 1.

/** Line breaks are the only control characters a note may hold (the reason rule). */
const LINE_BREAKS = /\r?\n|\r/g;

const receiptBodyLine = readOnlyGuarded(
  z.strictObject({
    lineId: z.uuid(),
    quantity: z.int().min(RECEIPT_QUANTITY_MIN).max(RECEIPT_QUANTITY_MAX),
  }),
  RECEIPT_READ_ONLY_FIELDS,
);

/** A receipt names a line once: the later entry of the same line is DUPLICATE_LINE_ID. */
const receiptBodyLines = z
  .array(receiptBodyLine)
  .min(ORDER_LINES_MIN)
  .max(ORDER_LINES_MAX)
  .superRefine((lines, ctx) => {
    const seen = new Set<string>();
    lines.forEach(({ lineId }, index) => {
      if (seen.has(lineId)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'lineId'],
          input: lineId,
          params: { fieldCode: 'DUPLICATE_LINE_ID' },
        });
      }
      seen.add(lineId);
    });
  });

export const recordReceiptBody = readOnlyGuarded(
  z.strictObject({
    /** The India receipt date, YYYY-MM-DD; "not after today" and "not before approval" are the service's. */
    receivedOn: z.iso.date(),
    note: plainText(RECEIPT_NOTE_MAX, LINE_BREAKS).nullable().optional(),
    lines: receiptBodyLines,
  }),
  RECEIPT_READ_ONLY_FIELDS,
).meta({ id: 'RecordReceiptBody' });

const recordedBy = z.strictObject({ id: z.uuid(), name: z.string() });

/** How much of an order has been received (research R8), as the order and a receipt show it. */
export const receiptProgress = z.enum(RECEIPT_PROGRESS).meta({ id: 'ReceiptProgress' });

/** The receipt's own fields, as every receipt response carries them. */
const receiptHead = {
  id: z.uuid(),
  receivedOn: z.iso.date(),
  recordedAt: z.iso.datetime(),
  note: z.string().nullable(),
};

/** The response of a recorded receipt, and the one its Idempotency-Key replays. */
export const recordedReceipt = z
  .strictObject({
    ...receiptHead,
    receiptProgress,
    lines: z.array(
      z.strictObject({
        lineId: z.uuid(),
        position: z.int(),
        quantity: z.int(),
        receivedBefore: z.int(),
        receivedAfter: z.int(),
        outstandingAfter: z.int(),
      }),
    ),
  })
  .meta({ id: 'RecordedReceipt' });

/** One row of the receipt history: the receipt and how many lines it covers. */
export const receiptSummary = z
  .strictObject({ ...receiptHead, recordedBy, lineCount: z.int() })
  .meta({ id: 'ReceiptSummary' });

export const receiptPage = pageOf(receiptSummary).meta({ id: 'ReceiptPage' });

/** One receipt with its lines (at most 500), in position order. */
export const receiptDetail = z
  .strictObject({
    ...receiptHead,
    recordedBy,
    lines: z.array(
      z.strictObject({
        line: z.strictObject({ id: z.uuid(), position: z.int(), description: z.string() }),
        quantity: z.int(),
      }),
    ),
  })
  .meta({ id: 'ReceiptDetail' });

export type RecordReceiptBody = z.infer<typeof recordReceiptBody>;
export type RecordedReceipt = z.infer<typeof recordedReceipt>;
export type ReceiptSummary = z.infer<typeof receiptSummary>;
export type ReceiptPage = z.infer<typeof receiptPage>;
export type ReceiptDetail = z.infer<typeof receiptDetail>;
