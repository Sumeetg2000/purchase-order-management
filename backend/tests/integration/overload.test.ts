import { createServer } from 'node:net';
import request, { type Response } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createApp } from '../../src/http/app.js';
import { requestIdOf } from '../../src/http/middleware/correlation.js';
import { defineRoute } from '../../src/http/define-route.js';
import { createTestDatabase } from '../support/db.js';
import { testLogger } from '../support/log-capture.js';
import { trackDatabase } from '../support/setup.js';

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

function prismaFor(url: string, poolSize = 1): AppPrismaClient {
  const client = createPrismaClient({ url, poolSize, connectionTimeoutMs: 200 });
  clients.push(client);
  return client;
}

function route(path: string, handler: Parameters<typeof defineRoute>[0]['handler']) {
  return defineRoute({
    method: 'get',
    path,
    operationId: `test${path.replaceAll('/', '_')}`,
    summary: 'test only',
    access: 'public',
    responses: { 200: z.object({}) },
    handler,
  });
}

function appFor(prisma: AppPrismaClient) {
  const tx = (res: Parameters<typeof requestIdOf>[0], timeoutMs = 2_000) => ({
    prisma,
    actor: { type: 'SYSTEM' as const },
    requestId: requestIdOf(res),
    timeoutMs,
    maxWaitMs: 200,
    retry: { retries: 3, baseDelayMs: 1 },
  });

  return createApp({
    logger: testLogger(),
    appOrigin: 'http://localhost:8080',
    routes: [
      route('/raw', async (_req, res) => {
        await prisma.$queryRaw`SELECT 1`;
        res.json({});
      }),
      route('/tx', async (_req, res) => {
        await withTransaction(tx(res), (t) => t.$queryRaw`SELECT 1`);
        res.json({});
      }),
      route('/slow-tx', async (_req, res) => {
        await withTransaction(tx(res, 300), (t) => t.$queryRaw`SELECT pg_sleep(0.6)::text`);
        res.json({});
      }),
      route('/conflict', async (_req, res) => {
        await withTransaction(tx(res), (t) =>
          t.$executeRawUnsafe(
            `DO $$ BEGIN RAISE EXCEPTION 'probe' USING ERRCODE = '40001'; END $$`,
          ),
        );
        res.json({});
      }),
    ],
  });
}

/**
 * Holds the only pooled connection for 1.5 s. Returned inside an object: an async function
 * returning the promise itself would wait for the hold to end.
 */
async function holdPool(prisma: AppPrismaClient): Promise<{ released: Promise<unknown> }> {
  const hold = prisma.$transaction((t) => t.$queryRaw`SELECT pg_sleep(1.5)::text`, {
    timeout: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { released: hold };
}

function expect503(res: Response, code = 'SERVICE_UNAVAILABLE') {
  expect(res.status).toBe(503);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.body).toMatchObject({ code, correlationId: res.headers['x-request-id'] });
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('[NFR-CON-02] overload returns 503, never 500 or a hang', () => {
  it('[NFR-CON-02] a query outside a transaction with the pool exhausted is 503 SERVICE_UNAVAILABLE', async () => {
    const db = trackDatabase(await createTestDatabase());
    const prisma = prismaFor(db.url('po_app'));
    const { released } = await holdPool(prisma);
    expect503(await request(appFor(prisma)).get('/raw'));
    await released;
  });

  it('[NFR-CON-02] a transaction waiting past maxWait with the pool exhausted is 503 SERVICE_UNAVAILABLE', async () => {
    const db = trackDatabase(await createTestDatabase());
    const prisma = prismaFor(db.url('po_app'));
    const { released } = await holdPool(prisma);
    expect503(await request(appFor(prisma)).get('/tx'));
    await released;
  });

  it('[NFR-CON-02] a transaction past its timeout is 503 SERVICE_UNAVAILABLE', async () => {
    const db = trackDatabase(await createTestDatabase());
    expect503(await request(appFor(prismaFor(db.url('po_app'), 2))).get('/slow-tx'));
  });

  it('[NFR-CON-02] serialization failures past the retries are 503 CONCURRENCY_RETRY_EXHAUSTED', async () => {
    const db = trackDatabase(await createTestDatabase());
    expect503(
      await request(appFor(prismaFor(db.url('po_app'), 2))).get('/conflict'),
      'CONCURRENCY_RETRY_EXHAUSTED',
    );
  });

  it('[NFR-CON-02] an unreachable database is 503 SERVICE_UNAVAILABLE', async () => {
    const url = `postgresql://po_app:unused@127.0.0.1:${String(await closedPort())}/po`;
    const app = appFor(prismaFor(url));
    expect503(await request(app).get('/raw'));
    expect503(await request(app).get('/tx'));
  });
});
