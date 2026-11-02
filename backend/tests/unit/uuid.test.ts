import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/lib/uuid.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('[NFR-OPS-02] UUIDv7', () => {
  it('[NFR-OPS-02] has the version 7 and RFC variant bits', () => {
    for (let i = 0; i < 100; i += 1) expect(uuidv7()).toMatch(UUID_V7);
  });

  it('[NFR-OPS-02] encodes the millisecond timestamp first, so ids sort by time', () => {
    const earlier = uuidv7(Date.UTC(2026, 0, 1));
    const later = uuidv7(Date.UTC(2026, 0, 1) + 1);
    expect(earlier < later).toBe(true);
    expect(earlier.replaceAll('-', '').slice(0, 12)).toBe(
      Date.UTC(2026, 0, 1).toString(16).padStart(12, '0'),
    );
  });
});
