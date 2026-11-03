import type { Clock } from '../../src/lib/clock.js';

/** A clock that stands still until the test moves it. */
export interface TestClock extends Clock {
  set(time: Date): void;
  advance(ms: number): void;
}

export function testClock(start = new Date('2026-11-03T09:00:00.000Z')): TestClock {
  let current = start.getTime();
  return {
    // A fresh Date each time, so no caller can move the clock by mutating the result.
    now: () => new Date(current),
    set: (time) => {
      current = time.getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
