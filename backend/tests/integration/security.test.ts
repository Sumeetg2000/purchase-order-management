import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp } from '../support/test-app.js';
import { defineRoute } from '../../src/http/define-route.js';
import { testLogger } from '../support/log-capture.js';

const APP_ORIGIN = 'http://localhost:8080';

function buildApp() {
  const calls = { write: 0 };
  const app = createTestApp({
    logger: testLogger(),
    appOrigin: APP_ORIGIN,
    testOnlyRoutes: [
      defineRoute({
        method: 'get',
        path: '/thing',
        operationId: 'testThing',
        summary: 'test only',
        access: 'public',
        responses: { 200: z.object({ ok: z.boolean() }) },
        handler: (_req, res) => {
          res.json({ ok: true });
        },
      }),
      defineRoute({
        method: 'post',
        path: '/thing',
        operationId: 'testWriteThing',
        summary: 'test only',
        access: 'public',
        request: { body: z.strictObject({ name: z.string() }) },
        responses: { 200: z.object({ ok: z.boolean() }) },
        handler: (_req, res) => {
          calls.write += 1;
          res.json({ ok: true });
        },
      }),
    ],
  });
  return { app, calls };
}

describe('[NFR-OPS-02] API security headers', () => {
  it('[NFR-OPS-02] sets helmet headers on API responses, success and error alike', async () => {
    const { app } = buildApp();
    for (const res of [await request(app).get('/thing'), await request(app).get('/missing')]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });
});

describe('[NFR-OPS-03] cross-origin requests are refused', () => {
  it('[NFR-OPS-03] an Origin other than APP_ORIGIN is 403 CSRF_REJECTED before the handler runs', async () => {
    const { app, calls } = buildApp();
    const write = await request(app)
      .post('/thing')
      .set('Origin', 'https://evil.example')
      .send({ name: 'x' });
    expect(write.status).toBe(403);
    expect(write.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(write.body).toMatchObject({ code: 'CSRF_REJECTED' });
    expect(calls.write).toBe(0);

    const read = await request(app).get('/thing').set('Origin', 'http://localhost:8081');
    expect(read.status).toBe(403);
  });

  it('[NFR-OPS-03] no Origin, or the same origin, passes', async () => {
    const { app, calls } = buildApp();
    expect((await request(app).post('/thing').send({ name: 'x' })).status).toBe(200);
    expect(
      (await request(app).post('/thing').set('Origin', APP_ORIGIN).send({ name: 'x' })).status,
    ).toBe(200);
    expect(calls.write).toBe(2);
  });

  it('[NFR-OPS-03] sends no CORS headers, and a cross-origin preflight is refused', async () => {
    const { app } = buildApp();
    const ok = await request(app).get('/thing').set('Origin', APP_ORIGIN);
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await request(app)
      .options('/thing')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('[NFR-OPS-02] body size limit', () => {
  it('[NFR-OPS-02] applies the 1 MB limit to every route', async () => {
    const { app, calls } = buildApp();
    const res = await request(app)
      .post('/thing')
      .set('Content-Type', 'application/json')
      .send(`{"name":"${'x'.repeat(1024 * 1024)}"}`);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(calls.write).toBe(0);
  });
});
