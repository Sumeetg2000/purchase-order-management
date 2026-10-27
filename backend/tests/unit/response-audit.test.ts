import { createServer } from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { testLogger } from '../support/log-capture.js';
import { auditedResponses } from '../support/response-audit.js';

// The suite-wide response audit must actually see the API's responses; otherwise every
// suite passes it vacuously.

describe('[NFR-API-02] the suite-wide response audit', () => {
  it('[NFR-API-02] records each response from an API app', async () => {
    const before = auditedResponses().length;
    const app = createApp({ logger: testLogger(), appOrigin: 'http://localhost:8080', routes: [] });
    await request(app).get('/nope');
    expect(auditedResponses().slice(before)).toEqual([
      expect.objectContaining({ method: 'GET', path: '/nope', status: 404 }),
    ]);
  });

  it('[NFR-API-02] skips a plain http server, such as the metrics listener', async () => {
    const before = auditedResponses().length;
    const server = createServer((_req, res) => {
      res.statusCode = 503;
      res.end('not the API');
    });
    await request(server).get('/metrics');
    expect(auditedResponses().slice(before)).toEqual([]);
  });
});
