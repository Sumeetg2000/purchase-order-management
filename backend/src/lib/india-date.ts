import { RECEIPT_TIME_ZONE } from '@po/contracts';
import type { Clock } from './clock.js';

// The business reads dates in India time: receipt dates (slice 6) and the outstanding
// report's ages (slice 7) are India calendar dates.

const INDIA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: RECEIPT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today in India time, `YYYY-MM-DD`. */
export function indiaToday(clock: Clock): string {
  return INDIA_DATE.format(clock.now());
}
