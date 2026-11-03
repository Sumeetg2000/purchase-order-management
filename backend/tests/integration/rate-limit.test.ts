import { AppError } from '@po/contracts';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { sendProblem } from '../../src/http/problem.js';
import { correlation } from '../../src/http/middleware/correlation.js';
import { createRateLimiter, type RateLimiter } from '../../src/rate-limit/service.js';
import { testClock, type TestClock } from '../support/clock.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

// Rate limits in PostgreSQL (ADR-0017 amended 2026-11-02, research R8): fixed windows, one
// upsert per hit, shared by every API instance.

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

function instance(db: TestDatabase, clock: TestClock): RateLimiter {
  const prisma = createPrismaClient({
    url: db.url('po_app'),
    poolSize: 4,
    connectionTimeoutMs: 2_000,
  });
  clients.push(prisma);
  return createRateLimiter({ prisma, clock });
}

async function setup(start = '2026-11-03T09:00:20.000Z') {
  const db = trackDatabase(await createTestDatabase());
  const clock = testClock(new Date(start));
  return { db, clock, limiter: instance(db, clock) };
}

/** The outcome of one hit: ok, or the Retry-After of the refusal. */
async function hit(limiter: RateLimiter, key = '10.0.0.1'): Promise<'ok' | number> {
  try {
    await limiter.hit('login-account', key);
    return 'ok';
  } catch (error) {
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      return error.retryAfterSeconds ?? Number.NaN;
    }
    throw error;
  }
}

async function hits(limiter: RateLimiter, count: number, key?: string) {
  const results: ('ok' | number)[] = [];
  for (let i = 0; i < count; i += 1) results.push(await hit(limiter, key));
  return results;
}

describe('[NFR-SEC-05] rate limiter', () => {
  it('[NFR-SEC-05] allows the limit within a window and refuses the next with RATE_LIMITED', async () => {
    const { limiter } = await setup();
    const results = await hits(limiter, 11);
    expect(results.slice(0, 10)).toEqual(Array(10).fill('ok'));
    // 09:00:20 in a one-minute window: 40 seconds to go.
    expect(results[10]).toBe(40);
  });

  it('[NFR-SEC-05] Retry-After rounds up to the next whole second', async () => {
    const { limiter } = await setup('2026-11-03T09:00:20.500Z');
    expect((await hits(limiter, 11))[10]).toBe(40);
  });

  it('[NFR-SEC-05] a new window starts a new count', async () => {
    const { limiter, clock } = await setup();
    await hits(limiter, 11);
    clock.advance(40_000);
    expect(await hit(limiter)).toBe('ok');
  });

  it('[NFR-SEC-05] counts each key and each bucket separately', async () => {
    const { limiter } = await setup();
    await hits(limiter, 10, '10.0.0.1');
    expect(await hit(limiter, '10.0.0.2')).toBe('ok');
    await expect(limiter.hit('login-ip', '10.0.0.1')).resolves.toBeUndefined();
  });

  it('[NFR-SEC-05] two API instances on one database share one limit', async () => {
    const { db, clock, limiter: a } = await setup();
    const b = instance(db, clock);
    await hits(a, 5);
    await hits(b, 5);
    expect(await hit(a)).toBe(40);
    expect(await hit(b)).toBe(40);
  });

  it('[NFR-SEC-05] concurrent hits never let more than the limit through', async () => {
    const { db, clock } = await setup();
    const limiters = [instance(db, clock), instance(db, clock)];
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => hit(limiters[i % 2] as RateLimiter)),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(10);
  });

  it('[NFR-SEC-05] keeps one row per bucket, key and window, with its end', async () => {
    const { db, limiter } = await setup();
    await hits(limiter, 3);
    const admin = await db.client('postgres');
    const { rows } = await admin.query<{
      bucket: string;
      key: string;
      start: string;
      end: string;
      hits: number;
    }>(
      `SELECT bucket, key, window_start::text AS start, window_end::text AS end, hits
         FROM rate_limit_counters`,
    );
    expect(rows).toEqual([
      {
        bucket: 'login-account',
        key: '10.0.0.1',
        start: '2026-11-03 09:00:00+00',
        end: '2026-11-03 09:01:00+00',
        hits: 3,
      },
    ]);
  });
});

describe('[NFR-SEC-05] Retry-After on the wire', () => {
  it('[NFR-SEC-05] a refusal with a retry time sends the Retry-After header', async () => {
    const app = express();
    app.use(correlation());
    app.get('/limited', (_req, res) => {
      sendProblem(res, new AppError('RATE_LIMITED', { retryAfterSeconds: 40 }));
    });
    const res = await request(app).get('/limited');
    expect(res.status).toBe(429);
    expect(res.get('Retry-After')).toBe('40');
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
  });
});
