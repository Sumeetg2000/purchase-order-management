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
