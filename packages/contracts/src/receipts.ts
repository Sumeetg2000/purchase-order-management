import type { ExceedingLine } from './errors.js';
import { LINE_QUANTITY_MAX, ORDER_ADMIN_READ_ONLY_MESSAGE } from './orders.js';

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

/** The detail of a pure Approver's 403 on a receipt (owner, 2026-11-25). */
export const ORDER_RECEIPT_APPROVER_MESSAGE =
  "Approvers can't record receipts. The order's Buyer records them.";
/** A receipt's route-level FORBIDDEN detail, by the caller's role. */
export const ORDER_RECEIPT_FORBIDDEN_DETAIL = {
  ADMIN: ORDER_ADMIN_READ_ONLY_MESSAGE,
  APPROVER: ORDER_RECEIPT_APPROVER_MESSAGE,
} as const;

/**
 * A line's number in human-readable text: positions count from 0 in every field, and
 * every sentence numbers lines from 1, never "line 0" (owner, 2026-11-25).
 */
export function lineNumber(position: number): number {
  return position + 1;
}

/** What an over-receipt records: nothing. */
export const RECEIPT_NOTHING_RECORDED = 'Nothing was recorded.';

/** One offending line of an over-receipt, as a sentence. */
export function exceedingLineSentence({ position, outstanding, requested }: ExceedingLine): string {
  return `Line ${String(lineNumber(position))} has only ${String(outstanding)} outstanding; you entered ${String(requested)}.`;
}

/** RECEIPT_EXCEEDS_OUTSTANDING's detail: nothing recorded, then every offending line. */
export function exceedingLinesDetail(lines: readonly ExceedingLine[]): string {
  return [RECEIPT_NOTHING_RECORDED, ...lines.map(exceedingLineSentence)].join(' ');
}
