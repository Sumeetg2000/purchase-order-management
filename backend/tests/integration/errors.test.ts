import { AppError, type ErrorCode } from '@po/contracts';
import request, { type Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp } from '../support/test-app.js';
import { defineRoute } from '../../src/http/define-route.js';
import { capturedLines, testLogger } from '../support/log-capture.js';

const APP_ORIGIN = 'http://localhost:8080';

function buildApp() {
  const calls = { create: 0, read: 0, archive: 0 };
  const app = createTestApp({
    logger: testLogger(),
    appOrigin: APP_ORIGIN,
    testOnlyRoutes: [
      defineRoute({
        method: 'post',
        path: '/items',
        operationId: 'testCreateItem',
        summary: 'test only',
        access: 'public',
        request: {
          body: z.strictObject({
            name: z.string().min(1).max(10),
            qty: z.number().int().min(1).max(100),
          }),
        },
        responses: { 201: z.object({ ok: z.boolean() }) },
        handler: (_req, res) => {
          calls.create += 1;
          res.status(201).json({ ok: true });
        },
      }),
      defineRoute({
        method: 'get',
        path: '/items/:id',
        operationId: 'testReadItem',
        summary: 'test only',
        access: 'public',
        request: { params: z.strictObject({ id: z.uuid() }) },
        responses: { 200: z.object({ ok: z.boolean() }) },
        handler: (_req, res) => {
          calls.read += 1;
          res.json({ ok: true });
        },
      }),
      defineRoute({
        method: 'post',
        path: '/items/:id/archive',
        operationId: 'testArchiveItem',
        summary: 'test only',
        access: 'public',
        request: { params: z.strictObject({ id: z.uuid() }) },
        responses: { 200: z.object({ ok: z.boolean() }) },
        handler: (_req, res) => {
          calls.archive += 1;
          res.json({ ok: true });
        },
      }),
      defineRoute({
        method: 'get',
        path: '/boom',
        operationId: 'testBoom',
        summary: 'test only',
        access: 'public',
        responses: { 200: z.object({}) },
        handler: () => {
          throw new Error('connection to db failed: password=xxxx-leak-xxxx');
        },
      }),
      defineRoute({
        method: 'get',
        path: '/unregistered',
        operationId: 'testUnregistered',
        summary: 'test only',
        access: 'public',
        responses: { 200: z.object({}) },
        handler: () => {
          throw new AppError('NOT_A_REAL_CODE' as ErrorCode);
        },
      }),
    ],
  });
  return { app, calls };
}

/** Every error body: problem+json, a registered code, and the header's correlation id. */
function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = res.body as Record<string, unknown>;
  expect(body).toMatchObject({ status, code, type: 'about:blank' });
  expect(typeof body['title']).toBe('string');
  expect(body['correlationId']).toBe(res.headers['x-request-id']);
  return body;
}

describe('[NFR-VAL-01] request validation before business logic', () => {
  it('[NFR-VAL-01] malformed JSON is 400 VALIDATION_FAILED with MALFORMED_JSON', async () => {
    const { app, calls } = buildApp();
    const res = await request(app)
      .post('/items')
      .set('Content-Type', 'application/json')
      .send('{"name": "a",');
    const body = expectProblem(res, 400, 'VALIDATION_FAILED');
    expect(body['details']).toEqual([{ path: 'body', code: 'MALFORMED_JSON' }]);
    expect(calls.create).toBe(0);
  });

  it('[NFR-VAL-01] a body without application/json is UNSUPPORTED_MEDIA_TYPE', async () => {
    const { app, calls } = buildApp();
    const res = await request(app).post('/items').set('Content-Type', 'text/plain').send('name=a');
    const body = expectProblem(res, 400, 'VALIDATION_FAILED');
    expect(body['details']).toEqual([
      { path: 'header.content-type', code: 'UNSUPPORTED_MEDIA_TYPE' },
    ]);
    expect(calls.create).toBe(0);
  });

  it('[NFR-VAL-01] an unknown field is UNKNOWN_FIELD at its path', async () => {
    const { app, calls } = buildApp();
    const res = await request(app).post('/items').send({ name: 'a', qty: 1, extra: true });
    const body = expectProblem(res, 400, 'VALIDATION_FAILED');
    expect(body['details']).toEqual([{ path: 'body.extra', code: 'UNKNOWN_FIELD' }]);
    expect(calls.create).toBe(0);
  });

  it('[NFR-VAL-01] maps schema failures to field codes, one detail per field', async () => {
    const { app } = buildApp();
    const missing = await request(app).post('/items').send({ qty: 1 });
    expect(expectProblem(missing, 400, 'VALIDATION_FAILED')['details']).toEqual([
      { path: 'body.name', code: 'REQUIRED' },
    ]);

    const limits = await request(app)
      .post('/items')
      .send({ name: 'x'.repeat(11), qty: 0 });
    expect(expectProblem(limits, 400, 'VALIDATION_FAILED')['details']).toEqual([
      { path: 'body.name', code: 'TOO_LONG' },
      { path: 'body.qty', code: 'OUT_OF_RANGE' },
    ]);

    const types = await request(app).post('/items').send({ name: '', qty: 'many' });
    expect(expectProblem(types, 400, 'VALIDATION_FAILED')['details']).toEqual([
      { path: 'body.name', code: 'TOO_SHORT' },
      { path: 'body.qty', code: 'INVALID_FORMAT' },
    ]);
  });

  it('[NFR-VAL-01] a non-UUID path id is INVALID_FORMAT and the handler never runs', async () => {
    const { app, calls } = buildApp();
    const res = await request(app).get('/items/not-a-uuid');
    const body = expectProblem(res, 400, 'VALIDATION_FAILED');
    expect(body['details']).toEqual([{ path: 'path.id', code: 'INVALID_FORMAT' }]);
    expect(calls.read).toBe(0);

    const ok = await request(app).get('/items/0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f');
    expect(ok.status).toBe(200);
  });

  it('[NFR-VAL-01] an undecodable path parameter is 400 INVALID_FORMAT, not a server error', async () => {
    const { app, calls } = buildApp();
    const res = await request(app).get('/items/%E0%A4%A');
    const body = expectProblem(res, 400, 'VALIDATION_FAILED');
    expect(body['details']).toEqual([{ path: 'path', code: 'INVALID_FORMAT' }]);
    expect(calls.read).toBe(0);
    const errorLines = capturedLines().filter(
      (line) => line['requestId'] === body['correlationId'] && line['msg'] === 'unhandled error',
    );
    expect(errorLines).toEqual([]);
  });

  it('[NFR-VAL-01] a route without a query or body schema accepts neither', async () => {
    const { app, calls } = buildApp();
    const id = '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f';

    const query = await request(app).get(`/items/${id}?foo=bar`);
    expect(expectProblem(query, 400, 'VALIDATION_FAILED')['details']).toEqual([
      { path: 'query.foo', code: 'UNKNOWN_FIELD' },
    ]);

    const body = await request(app)
      .post(`/items/${id}/archive`)
      .send({ status: 'APPROVED', total: 0 });
    expect(expectProblem(body, 400, 'VALIDATION_FAILED')['details']).toEqual([
      { path: 'body.status', code: 'UNKNOWN_FIELD' },
      { path: 'body.total', code: 'UNKNOWN_FIELD' },
    ]);
    expect(calls.read + calls.archive).toBe(0);

    expect((await request(app).post(`/items/${id}/archive`)).status).toBe(200);
    expect(calls.archive).toBe(1);
  });

  it('[NFR-VAL-01] a valid request reaches the handler', async () => {
    const { app, calls } = buildApp();
    const res = await request(app).post('/items').send({ name: 'bolts', qty: 5 });
    expect(res.status).toBe(201);
    expect(calls.create).toBe(1);
  });
});

describe('[NFR-API-02] standard error responses', () => {
  it('[NFR-API-02] a body over 1 MB is 413 PAYLOAD_TOO_LARGE, refused before parsing', async () => {
    const { app, calls } = buildApp();
    const big = 'x'.repeat(1024 * 1024 + 1);
    const json = await request(app)
      .post('/items')
      .set('Content-Type', 'application/json')
      .send(`{"name":"${big}"}`);
    expectProblem(json, 413, 'PAYLOAD_TOO_LARGE');

    // Refused on size before the content type is even considered.
    const text = await request(app).post('/items').set('Content-Type', 'text/plain').send(big);
    expectProblem(text, 413, 'PAYLOAD_TOO_LARGE');
    expect(calls.create).toBe(0);
  });

  it('[NFR-API-02] an unknown route is 404 NOT_FOUND', async () => {
    const { app } = buildApp();
    expectProblem(await request(app).get('/nope'), 404, 'NOT_FOUND');
  });

  it('[NFR-API-02] an undefined method on a known path is 404 NOT_FOUND', async () => {
    const { app } = buildApp();
    expectProblem(await request(app).delete('/items'), 404, 'NOT_FOUND');
  });

  it('[NFR-API-02] an unexpected error is 500 INTERNAL_ERROR with no internal detail, logged with the same id', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/boom');
    const body = expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(Object.keys(body).sort()).toEqual(['code', 'correlationId', 'status', 'title', 'type']);
    expect(res.text).not.toContain('xxxx-leak-xxxx');
    expect(res.text).not.toMatch(/at .*\.(ts|js):\d+/);

    const logged = capturedLines().filter(
      (line) => line['requestId'] === body['correlationId'] && line['level'] === 50,
    );
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).toContain('connection to db failed');
  });

  it('[NFR-API-02] throwing an unregistered code fails at run time and becomes INTERNAL_ERROR', async () => {
    const { app } = buildApp();
    expectProblem(await request(app).get('/unregistered'), 500, 'INTERNAL_ERROR');
  });
});
