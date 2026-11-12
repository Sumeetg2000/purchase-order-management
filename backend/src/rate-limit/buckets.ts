// Rate-limit buckets (ADR-0017, amended 2026-11-02 and 2026-11-03): each one counts hits
// per key within a fixed window. rate_limit_counters.bucket (migration 0010_rate_limits)
// allows exactly these names; tests/integration/accounts-schema.test.ts pins the copy.

import { DAY_SECONDS, HOUR_SECONDS, MINUTE_SECONDS } from '../lib/time.js';

interface RateLimitBucketDefinition {
  name: string;
  /** Hits allowed per window; the next one is refused. */
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_BUCKETS = [
  // Offices share one IP, hence the higher per-IP login limit.
  { name: 'login-ip', limit: 30, windowSeconds: MINUTE_SECONDS },
  { name: 'login-account', limit: 10, windowSeconds: MINUTE_SECONDS },
  { name: 'signup-ip', limit: 5, windowSeconds: HOUR_SECONDS },
  { name: 'signup-email', limit: 3, windowSeconds: HOUR_SECONDS },
  { name: 'resend-email', limit: 3, windowSeconds: HOUR_SECONDS },
  { name: 'forgot-email', limit: 3, windowSeconds: HOUR_SECONDS },
  { name: 'access-request-user', limit: 3, windowSeconds: DAY_SECONDS },
] as const satisfies readonly RateLimitBucketDefinition[];

export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number]['name'];

export const RATE_LIMIT_BUCKET_NAMES: readonly RateLimitBucket[] = RATE_LIMIT_BUCKETS.map(
  (bucket) => bucket.name,
);
