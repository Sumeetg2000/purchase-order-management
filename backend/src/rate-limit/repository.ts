import type { AppPrismaClient } from '../db/client.js';
import type { RateLimitBucket } from './buckets.js';

interface RateLimitWindow {
  bucket: RateLimitBucket;
  key: string;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Counts one hit in a window and returns the window's total, in one statement, so
 * concurrent hits on any instance can't both read the same count. It runs on its own,
 * outside any transaction: a hit counts even when the command it guards fails.
 */
export async function countHit(prisma: AppPrismaClient, window: RateLimitWindow): Promise<number> {
  const [row] = await prisma.$queryRaw<{ hits: number }[]>`
    INSERT INTO rate_limit_counters (bucket, key, window_start, window_end, hits)
    VALUES (${window.bucket}, ${window.key}, ${window.windowStart}, ${window.windowEnd}, 1)
    ON CONFLICT (bucket, key, window_start)
      DO UPDATE SET hits = rate_limit_counters.hits + 1
    RETURNING hits`;
  if (!row) throw new Error('rate_limit_counters upsert returned no row');
  return row.hits;
}
