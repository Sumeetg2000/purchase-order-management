import { BODY_LIMIT_BYTES, ORDER_BODY_LIMIT_BYTES } from '@po/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRoute, type RouteDefinition } from '../../src/http/define-route.js';
import { APP_ORIGIN, authApp, sessionHeaders } from '../support/auth-app.js';
import { listen, rawRequest, type RawServer } from '../support/raw-http.js';

// Request bodies are read per operation, after authentication, CSRF and the role check, up
// to the operation's limit (slice 3 research R8). A request refused before its body is read
// is answered with Connection: close and the body is never read.

const handled: string[] = [];
const servers: RawServer[] = [];
afterEach(async () => {
  handled.length = 0;
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const body = z.strictObject({ name: z.string() });

function route(path: string, extra: Partial<RouteDefinition> = {}): RouteDefinition {
  return defineRoute({
    method: 'post',
    path,
    operationId: `test${path.replaceAll(/[^a-z]/gi, '')}`,
    summary: 'test only',
    access: 'role',
    roles: ['BUYER'],
    request: { body },
    responses: { 200: z.strictObject({ bytes: z.int() }) },
    handler: (req, res) => {
      handled.push(path);
      res.json({ bytes: JSON.stringify(req.body).length });
    },
    ...extra,
  });
}

const ROUTES = [
  route('/probe/default'),
  route('/probe/large', { bodyLimitBytes: ORDER_BODY_LIMIT_BYTES }),
];

async function setup() {
  const { app, seed } = await authApp(ROUTES);
  const server = await listen(app);
  servers.push(server);
  return { server, buyer: await seed('{BUYER}'), admin: await seed('{ADMIN}') };
}

/** A JSON body of exactly `bytes` bytes. */
function jsonOf(bytes: number): string {
  const shell = '{"name":""}';
  return `{"name":"${'x'.repeat(bytes - shell.length)}"}`;
}

describe('[NFR-VAL-01] request body limits per operation', () => {
  it("[NFR-VAL-01] a body over its operation's limit by Content-Length is 413; at the limit it is parsed", async () => {
    const { server, buyer } = await setup();
    const post = (path: string, bytes: number) =>
      fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
        method: 'POST',
        headers: { ...sessionHeaders(buyer), 'Content-Type': 'application/json' },
        body: jsonOf(bytes),
      });

    expect((await post('/probe/default', BODY_LIMIT_BYTES)).status).toBe(200);
    const over = await post('/probe/default', BODY_LIMIT_BYTES + 1);
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    expect((await post('/probe/large', ORDER_BODY_LIMIT_BYTES)).status).toBe(200);
    expect((await post('/probe/large', ORDER_BODY_LIMIT_BYTES + 1)).status).toBe(413);
    expect(handled).toEqual(['/probe/default', '/probe/large']);
  });

  it('[NFR-VAL-01] a refusal before parsing closes the connection without reading the body', async () => {
    const { server, buyer, admin } = await setup();
    const cases: [string, Record<string, string>, number, string][] = [
      ['no session', { Origin: APP_ORIGIN }, 401, 'UNAUTHENTICATED'],
      ['no CSRF token', sessionHeaders(buyer, { csrf: false }), 403, 'CSRF_REJECTED'],
      ['wrong role', sessionHeaders(admin), 403, 'FORBIDDEN'],
      [
        'foreign origin',
        { ...sessionHeaders(buyer), Origin: 'https://evil.example' },
        403,
        'CSRF_REJECTED',
      ],
      ['over the limit', sessionHeaders(buyer), 413, 'PAYLOAD_TOO_LARGE'],
    ];
    for (const [name, headers, status, code] of cases) {
      const res = await rawRequest(server.port, {
        method: 'POST',
        path: name === 'over the limit' ? '/probe/default' : '/probe/large',
        headers,
        contentLength: name === 'over the limit' ? BODY_LIMIT_BYTES + 1 : ORDER_BODY_LIMIT_BYTES,
        sendBytes: 1024,
      });
      expect(res.status, name).toBe(status);
      expect(JSON.parse(res.body) as unknown, name).toMatchObject({ code });
      expect(res.headers['connection'], name).toBe('close');
      expect(res.closed, name).toBe(true);
      // The headers and at most the first chunk: never the declared megabytes.
      expect(server.lastBytesRead(), name).toBeLessThan(64 * 1024);
    }
    expect(handled).toEqual([]);
  });

  it('[NFR-VAL-01] a chunked body over the limit is 413 and never parsed', async () => {
    const { server, buyer } = await setup();
    for (const [path, limit] of [
      ['/probe/default', BODY_LIMIT_BYTES],
      ['/probe/large', ORDER_BODY_LIMIT_BYTES],
    ] as const) {
      const res = await rawRequest(server.port, {
        method: 'POST',
        path,
        headers: sessionHeaders(buyer),
        chunkedBytes: limit + 64 * 1024,
      });
      expect(res.status, path).toBe(413);
      expect(JSON.parse(res.body) as unknown, path).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      expect(res.headers['connection'], path).toBe('close');
      expect(res.closed, path).toBe(true);
    }
    expect(handled).toEqual([]);
  });
});
