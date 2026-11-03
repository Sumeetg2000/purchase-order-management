import { AppError } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import { withDatabase } from '../db/transaction.js';
import type { Clock } from '../lib/clock.js';
import { RATE_LIMIT_BUCKETS, type RateLimitBucket } from './buckets.js';
import { countHit } from './repository.js';

// Fixed-window rate limits kept in PostgreSQL (ADR-0017 amended 2026-11-02, research R8):
// every API instance shares the counts. Windows align to the epoch, so all instances agree
// on where one starts.

const SECOND_MS = 1_000;

export interface RateLimiter {
  /**
   * Counts a hit for the key, and throws 429 RATE_LIMITED with Retry-After when the
   * bucket's limit for the current window is already used up. Call it before the
   * command's transaction and before any lookup.
   */
  hit(bucket: RateLimitBucket, key: string): Promise<void>;
}

const BUCKETS = new Map(RATE_LIMIT_BUCKETS.map((bucket) => [bucket.name, bucket]));

export function createRateLimiter(deps: { prisma: AppPrismaClient; clock: Clock }): RateLimiter {
  return {
    hit: async (bucket, key) => {
      const definition = BUCKETS.get(bucket);
      if (!definition) throw new Error(`Unknown rate-limit bucket ${bucket}`);
      const now = deps.clock.now().getTime();
      const windowMs = definition.windowSeconds * SECOND_MS;
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const windowEnd = windowStart + windowMs;
      const hits = await withDatabase(() =>
        countHit(deps.prisma, {
          bucket,
          key,
          windowStart: new Date(windowStart),
          windowEnd: new Date(windowEnd),
        }),
      );
      if (hits > definition.limit) {
        throw new AppError('RATE_LIMITED', {
          retryAfterSeconds: Math.ceil((windowEnd - now) / SECOND_MS),
        });
      }
    },
  };
}
