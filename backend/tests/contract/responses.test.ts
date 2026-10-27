import { AppError } from '@po/contracts';
import request, { type Response } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createTestApp } from '../support/test-app.js';
import { defineRoute } from '../../src/http/define-route.js';
import { healthRoutes } from '../../src/health/routes.js';
import { createReadinessService, listMigrations } from '../../src/health/service.js';
import { createTestDatabase } from '../support/db.js';
import { testLogger } from '../support/log-capture.js';
import { validateResponse } from '../support/openapi-validator.js';
import { trackDatabase } from '../support/setup.js';

// Every response the health and error suites rely on, validated against the
// committed packages/contracts/openapi/openapi.json. Routes the document doesn't know
// (unknown paths, and the test-only routes that provoke 400, 413 and 500) must still answer
// with the document's shared Problem response.

const APP_ORIGIN = 'http://localhost:8080';
const clients: AppPrismaClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

async function appFor(url: string) {
  const prisma = createPrismaClient({ url, poolSize: 2, connectionTimeoutMs: 1_000 });
  clients.push(prisma);
  return createTestApp({
    logger: testLogger(),
    appOrigin: APP_ORIGIN,
    routes: healthRoutes(
      createReadinessService({ prisma, expectedMigrations: await listMigrations() }),
    ),
    testOnlyRoutes: [
      defineRoute({
        method: 'post',
        path: '/test-items',
        operationId: 'testCreateItem',
        summary: 'test only',
        access: 'public',
        request: { body: z.strictObject({ name: z.string().min(1).max(10) }) },
        responses: { 201: z.object({ ok: z.boolean() }) },
        handler: (_req, res) => {
          res.status(201).json({ ok: true });
        },
      }),
      defineRoute({
        method: 'get',
        path: '/test-boom',
        operationId: 'testBoom',
        summary: 'test only',
        access: 'public',
        responses: { 200: z.object({}) },
        handler: () => {
          throw new Error('unexpected');
        },
      }),
      defineRoute({
        method: 'get',
        path: '/test-busy',
        operationId: 'testBusy',
        summary: 'test only',
        access: 'public',
        responses: { 200: z.object({}) },
        handler: () => {
          throw new AppError('CONCURRENCY_RETRY_EXHAUSTED');
        },
      }),
    ],
  });
}

function expectValid(res: Response, method: string, path: string, status: number) {
  expect(res.status, `${method} ${path}`).toBe(status);
  const errors = validateResponse({
    method,
    path,
    status: res.status,
    headers: res.headers,
    body: res.body as unknown,
  });
  expect(errors, `${method} ${path} ${String(status)}`).toEqual([]);
}

describe('[NFR-API-01] responses match the committed OpenAPI document', () => {
  it('[NFR-API-01] /healthz 200 and /readyz 200', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await appFor(db.url('po_app'));
    expectValid(await request(app).get('/healthz'), 'get', '/healthz', 200);
    expectValid(await request(app).get('/readyz'), 'get', '/readyz', 200);
  });

  it('[NFR-API-01] /readyz 503 SERVICE_UNAVAILABLE when the database is unreachable', async () => {
    const app = await appFor('postgresql://po_app:unused@127.0.0.1:9/none');
    expectValid(await request(app).get('/readyz'), 'get', '/readyz', 503);
  });

  it('[NFR-API-01] validation failures, unknown routes and methods, size, origin and server errors', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await appFor(db.url('po_app'));
    const post = () => request(app).post('/test-items').set('Origin', APP_ORIGIN);

    expectValid(await request(app).get('/healthz?debug=1'), 'get', '/healthz', 400);
    expectValid(
      await post().set('Content-Type', 'application/json').send('{"name":'),
      'post',
      '/test-items',
      400,
    );
    expectValid(
      await post().set('Content-Type', 'text/plain').send('x'),
      'post',
      '/test-items',
      400,
    );
    expectValid(await post().send({ name: 'ok', extra: 1 }), 'post', '/test-items', 400);
    expectValid(await request(app).get('/nope'), 'get', '/nope', 404);
    expectValid(await request(app).delete('/healthz'), 'delete', '/healthz', 404);
    expectValid(
      await post()
        .set('Content-Type', 'application/json')
        .send(`{"name":"${'x'.repeat(1024 * 1024 + 1)}"}`),
      'post',
      '/test-items',
      413,
    );
    expectValid(
      await request(app)
        .post('/test-items')
        .set('Origin', 'https://evil.example')
        .send({ name: 'x' }),
      'post',
      '/test-items',
      403,
    );
    expectValid(await request(app).get('/test-boom'), 'get', '/test-boom', 500);
    expectValid(await request(app).get('/test-busy'), 'get', '/test-busy', 503);
  });

  it('[NFR-API-01] the validator rejects an error code or status the operation does not declare', () => {
    const problem = (status: number, code: string) => ({
      method: 'get',
      path: '/readyz',
      status,
      headers: {
        'content-type': 'application/problem+json',
        'x-request-id': 'req-contract-02',
      },
      body: { type: 'about:blank', title: 'x', status, code, correlationId: 'req-contract-02' },
    });
    expect(validateResponse(problem(503, 'SERVICE_UNAVAILABLE'))).toEqual([]);
    expect(validateResponse(problem(503, 'CONCURRENCY_RETRY_EXHAUSTED'))).toEqual([
      expect.stringMatching(/CONCURRENCY_RETRY_EXHAUSTED/),
    ]);
    expect(validateResponse(problem(409, 'NOT_FOUND'))).toEqual([
      expect.stringMatching(/undocumented status/),
    ]);
  });

  it('[NFR-API-01] the validator rejects a response that breaks the document', () => {
    const errors = validateResponse({
      method: 'get',
      path: '/healthz',
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-contract-01' },
      body: { status: 'ok', extra: true },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(
      validateResponse({
        method: 'get',
        path: '/healthz',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { status: 'ok' },
      }),
    ).toEqual([expect.stringMatching(/X-Request-Id/)]);
    expect(
      validateResponse({
        method: 'get',
        path: '/healthz',
        status: 201,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-contract-01' },
        body: { status: 'ok' },
      }),
    ).toEqual([expect.stringMatching(/undocumented/)]);
  });
});
