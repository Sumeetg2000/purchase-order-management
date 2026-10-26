import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../src/http/app.js';
import { defineRoute } from '../../src/http/define-route.js';
import { sendProblem } from '../../src/http/problem.js';
import { createMetrics, createMetricsServer } from '../../src/observability/metrics.js';

function testApp() {
  const metrics = createMetrics();
  const app = createApp({
    metrics,
    routes: [
      defineRoute({
        method: 'get',
        path: '/items/:id',
        operationId: 'testItem',
        summary: 'test only',
        access: 'public',
        responses: { 200: z.object({ ok: z.boolean() }) },
        handler: (_req, res) => {
          res.json({ ok: true });
        },
      }),
      defineRoute({
        method: 'get',
        path: '/unavailable',
        operationId: 'testUnavailable',
        summary: 'test only',
        access: 'public',
        responses: { 503: z.object({}) },
        handler: (_req, res) => {
          sendProblem(res, {
            status: 503,
            code: 'SERVICE_UNAVAILABLE',
            title: 'Service unavailable',
          });
        },
      }),
    ],
  });
  return { app, metrics, metricsServer: createMetricsServer(metrics) };
}

async function scrape(server: ReturnType<typeof createMetricsServer>) {
  const res = await request(server).get('/metrics');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/plain/);
  return res.text;
}

describe('[NFR-OPS-02] internal metrics listener', () => {
  it('[NFR-OPS-02] serves Prometheus text with request counters, latency and process metrics', async () => {
    const { app, metricsServer } = testApp();
    await request(app).get('/items/42').expect(200);

    const text = await scrape(metricsServer);
    expect(text).toContain(
      'po_http_requests_total{method="GET",route="/items/:id",status_class="2xx"} 1',
    );
    expect(text).toContain('po_http_request_duration_seconds_bucket{');
    expect(text).toContain('po_process_cpu_user_seconds_total');
    expect(text).toContain('po_nodejs_eventloop_lag_seconds');
  });

  it('[NFR-OPS-02] the main port returns 404 for /metrics', async () => {
    const { app } = testApp();
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('po_http_');
  });

  it('[NFR-OPS-02] labels use route patterns, never raw paths or query strings', async () => {
    const { app, metricsServer } = testApp();
    await request(app).get('/items/a1b2-raw-id?email=someone%40example.com');
    await request(app).get('/no-such-path-raw-xyz');

    const text = await scrape(metricsServer);
    expect(text).toContain('route="/items/:id"');
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('a1b2-raw-id');
    expect(text).not.toContain('no-such-path-raw-xyz');
    expect(text).not.toContain('example.com');
  });

  it('[NFR-OPS-02] counts errors by route and registry code', async () => {
    const { app, metricsServer } = testApp();
    await request(app).get('/unavailable').expect(503);

    const text = await scrape(metricsServer);
    expect(text).toContain(
      'po_http_errors_total{route="/unavailable",code="SERVICE_UNAVAILABLE"} 1',
    );
    expect(text).toContain('status_class="5xx"');
  });

  it('[NFR-OPS-02] the metrics listener serves nothing but /metrics', async () => {
    const { metricsServer } = testApp();
    expect((await request(metricsServer).get('/')).status).toBe(404);
    expect((await request(metricsServer).get('/healthz')).status).toBe(404);
    expect((await request(metricsServer).post('/metrics')).status).toBe(405);
  });
});
