import type { AgeBucket } from '@po/contracts';
import { formatDate } from '../../format/date';

// The outstanding report's words, in one place (specs/008-outstanding-report/contracts/
// ui.md). A Record over AgeBucket, so a new band fails the type check until it is named.

export const AGE_BUCKET_LABELS: Record<AgeBucket, string> = {
  DAYS_0_30: '0–30 days',
  DAYS_31_60: '31–60 days',
  DAYS_61_90: '61–90 days',
  OVER_90: 'Over 90 days',
};

/** An order's age in whole India days: "today", "1 day", "{n} days". */
export function ageText(days: number): string {
  if (days === 0) return 'today';
  return days === 1 ? '1 day' : `${String(days)} days`;
}

/** The date a page's ages are counted to. */
export function asOfLine(asOf: string): string {
  return `Ages as of ${formatDate(asOf)} (India time)`;
}

/** "2 of 5": open lines of all the order's lines. */
export function openLinesText(open: number, count: number): string {
  return `${String(open)} of ${String(count)}`;
}

export const NOTHING_OUTSTANDING = 'Nothing is outstanding.';
export const NO_MATCHING_ORDERS = 'No outstanding orders match these filters.';
