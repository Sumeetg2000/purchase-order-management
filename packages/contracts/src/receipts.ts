import { LINE_QUANTITY_MAX } from './orders.js';

// Goods receipt constants (specs/007-goods-receipt/data-model.md, research R1, R4, R8).
// The receipts table's CHECKs and triggers (migration 0016_receipts) hold SQL copies of
// these; backend/tests/integration/order-constants.test.ts and receipt-triggers.test.ts
// pin each copy.

/** How much of an order has been received, derived from its lines and receipts. */
export const RECEIPT_PROGRESS = ['NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'] as const;
export type ReceiptProgress = (typeof RECEIPT_PROGRESS)[number];

/** A receipt's quantity, a whole number: the line quantity rule. */
export const RECEIPT_QUANTITY_MIN = 1;
export const RECEIPT_QUANTITY_MAX = LINE_QUANTITY_MAX;

/** A receipt note, in Unicode code points. */
export const RECEIPT_NOTE_MAX = 500;

/** Receipt dates are calendar dates in India time: the approval date, "today". */
export const RECEIPT_TIME_ZONE = 'Asia/Kolkata';

/**
 * Derived or system-assigned receipt fields: refused in a receipt body, and in its lines,
 * with READ_ONLY_FIELD (ADR-0003), by their response names.
 */
export const RECEIPT_READ_ONLY_FIELDS = [
  'id',
  'recordedAt',
  'recordedBy',
  'receiptProgress',
  'lineCount',
  'position',
  'receivedBefore',
  'receivedAfter',
  'outstandingAfter',
] as const;
