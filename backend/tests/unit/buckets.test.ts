import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_BUCKET_NAMES, RATE_LIMIT_BUCKETS } from '../../src/rate-limit/buckets.js';

// The rate limits of ADR-0017 (amended 2026-11-02 and 2026-11-03): login per IP and per
// account, signup per IP and per email, resend and forgot-password per email only.

describe('[NFR-SEC-05] rate-limit buckets', () => {
  it('[NFR-SEC-05] lists every limit of ADR-0017 once, with its window', () => {
    expect(
      RATE_LIMIT_BUCKETS.map((b) => `${b.name} ${String(b.limit)}/${String(b.windowSeconds)}s`),
    ).toEqual([
      'login-ip 30/60s',
      'login-account 10/60s',
      'signup-ip 5/3600s',
      'signup-email 3/3600s',
      'resend-email 3/3600s',
      'forgot-email 3/3600s',
      'access-request-user 3/86400s',
    ]);
    expect(new Set(RATE_LIMIT_BUCKET_NAMES).size).toBe(RATE_LIMIT_BUCKETS.length);
  });

  it('[NFR-SEC-08] resend-verification and forgot-password have no per-IP bucket', () => {
    expect(RATE_LIMIT_BUCKET_NAMES).not.toContain('resend-ip');
    expect(RATE_LIMIT_BUCKET_NAMES).not.toContain('forgot-ip');
  });
});
