import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../src/http/app.js';
import { defineRoute } from '../../src/http/define-route.js';
import { testLogger } from '../support/log-capture.js';

const app = createApp({
  logger: testLogger(),
  appOrigin: 'http://localhost:8080',
  routes: [
    defineRoute({
      method: 'get',
      path: '/ip',
      operationId: 'testIp',
      summary: 'test only',
      access: 'public',
      responses: { 200: z.object({ ip: z.string() }) },
      handler: (req, res) => {
        res.json({ ip: req.ip });
      },
    }),
  ],
});

describe('[NFR-OPS-02] client address behind the edge', () => {
  it('[NFR-OPS-02] trusts only the address the edge adds, ignoring a forged X-Forwarded-For', async () => {
    // nginx replaces X-Forwarded-For with the connecting address; if a forged value ever
    // got through ahead of it, only the last hop (the edge's) is believed.
    const res = await request(app).get('/ip').set('X-Forwarded-For', '6.6.6.6, 203.0.113.7');
    expect(res.body).toEqual({ ip: '203.0.113.7' });
  });

  it('[NFR-OPS-02] uses the edge-supplied address when there is one hop', async () => {
    const res = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(res.body).toEqual({ ip: '203.0.113.7' });
  });
});
