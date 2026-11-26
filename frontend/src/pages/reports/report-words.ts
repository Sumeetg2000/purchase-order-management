import { AGE_BUCKET_UPPER_DAYS, AGE_BUCKETS, type AgeBucket } from '@po/contracts';
import { formatDate } from '../../format/date';

// The outstanding report's words, in one place (specs/008-outstanding-report/contracts/
// ui.md). The band labels are built from AGE_BUCKET_UPPER_DAYS, so they always say the
// bounds the API counts with.

/** "0–30 days", "31–60 days", "61–90 days", "Over 90 days". */
export const AGE_BUCKET_LABELS = Object.fromEntries(
  AGE_BUCKETS.map((bucket, i) => {
    const upper = AGE_BUCKET_UPPER_DAYS[i];
    const lower = i === 0 ? 0 : (AGE_BUCKET_UPPER_DAYS[i - 1] ?? 0) + 1;
    const last = AGE_BUCKET_UPPER_DAYS[AGE_BUCKET_UPPER_DAYS.length - 1] ?? 0;
    return [
      bucket,
      upper === undefined ? `Over ${String(last)} days` : `${String(lower)}–${String(upper)} days`,
    ];
  }),
) as Record<AgeBucket, string>;

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
