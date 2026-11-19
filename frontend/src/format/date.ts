// Dates as the users read them: Indian English, in India's time zone (ADR-0010's en-IN
// locale), e.g. "1 November 2026".

const LONG_DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

export function formatDate(iso: string): string {
  return LONG_DATE.format(new Date(iso));
}

const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

/** A moment, e.g. "11 November 2026 at 2:30 pm", in India's time zone. */
export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

const RELATIVE = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long ago a moment was, e.g. "3 days ago", "2 hours ago", "this minute". */
export function formatAge(iso: string, now: Date = new Date()): string {
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (elapsed >= DAY_MS) return RELATIVE.format(-Math.floor(elapsed / DAY_MS), 'day');
  if (elapsed >= HOUR_MS) return RELATIVE.format(-Math.floor(elapsed / HOUR_MS), 'hour');
  return RELATIVE.format(-Math.floor(Math.max(elapsed, 0) / MINUTE_MS), 'minute');
}
