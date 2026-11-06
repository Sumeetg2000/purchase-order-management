import { describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lib/clock.js';
import { testClock } from '../support/clock.js';

describe('[NFR-SEC-09] clock', () => {
  it('[NFR-SEC-09] the system clock reads the current time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('[NFR-SEC-09] the test clock stands still until set or advanced', () => {
    const clock = testClock(new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(15 * 60 * 1_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:15:00.000Z');
    clock.set(new Date('2026-02-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('[NFR-SEC-09] mutating a returned date does not move the test clock', () => {
    const clock = testClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.now().setUTCFullYear(2030);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
