// Time units, defined once (CLAUDE.md: shared values are named constants).

export const SECOND_MS = 1_000;
export const MINUTE_SECONDS = 60;
export const HOUR_SECONDS = 60 * MINUTE_SECONDS;
export const DAY_SECONDS = 24 * HOUR_SECONDS;

/** A time some seconds after another. */
export function plus(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * SECOND_MS);
}

/** Whole seconds from now until a time, never less than one. */
export function secondsUntil(time: Date, now: Date): number {
  return Math.max(1, Math.ceil((time.getTime() - now.getTime()) / SECOND_MS));
}
