import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp } from '../support/test-app.js';
import { defineRoute } from '../../src/http/define-route.js';
import { logOneTimeLink } from '../../src/observability/logger.js';
import { createCapture, findTokenLeaks, type LogLine } from '../support/log-capture.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Low-entropy stand-in for a 256-bit base64url token (43 characters).
const FAKE_TOKEN = 'x'.repeat(43);

function buildApp() {
  const capture = createCapture();
  const app = createTestApp({
    logger: capture.logger,
    appOrigin: 'http://localhost:8080',
    routes: [
      defineRoute({
        method: 'get',
        path: '/fail',
        operationId: 'testFail',
        summary: 'test only',
        access: 'public',
        responses: { 200: z.object({}) },
        handler: () => {
          throw Object.assign(new Error('upstream refused'), {
            config: { headers: { authorization: 'Bearer xxxx-auth-12' } },
          });
        },
      }),
      defineRoute({
        method: 'get',
        path: '/work',
        operationId: 'testWork',
        summary: 'test only',
        access: 'public',
        request: {
          query: z.strictObject({ token: z.string().optional(), page: z.string().optional() }),
        },
        responses: { 200: z.object({}) },
        handler: (req, res) => {
          req.log.info({ step: 'inside handler' }, 'working');
          req.log.info(
            {
              user: {
                password: 'xxxx-pw-1',
                profile: {
                  phone: '+910000000000',
                  apiToken: 'xxxx-tok-2',
                  clientSecret: 'xxxx-sec-3',
                },
              },
              items: [{ newPassword: 'xxxx-pw-4' }],
            },
            'nested sensitive values',
          );
          res.cookie('sid', 'xxxx-cookie-5').json({});
        },
      }),
    ],
  });
  return { app, lines: capture.lines };
}

function linesFor(lines: readonly LogLine[], requestId: string) {
  return lines.filter((line) => line['requestId'] === requestId);
}

describe('[NFR-OPS-02] correlation ids', () => {
  it('[NFR-OPS-02] echoes a valid X-Request-Id and logs every line of the request with it', async () => {
    const { app, lines } = buildApp();
    const res = await request(app).get('/work').set('X-Request-Id', 'client-req.0001_ok');
    expect(res.headers['x-request-id']).toBe('client-req.0001_ok');

    const own = linesFor(lines, 'client-req.0001_ok');
    expect(own.map((l) => l['msg'])).toEqual(
      expect.arrayContaining(['working', 'nested sensitive values', 'request completed']),
    );
    // No line of this request is missing the id.
    const untagged = lines.filter((l) => l['msg'] === 'working' && l['requestId'] === undefined);
    expect(untagged).toEqual([]);
  });

  it('[NFR-OPS-02] echoes a 36-character id, such as a client-generated UUID', async () => {
    const { app } = buildApp();
    const id = '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f';
    const res = await request(app).get('/work').set('X-Request-Id', id);
    expect(res.headers['x-request-id']).toBe(id);
  });

  it.each([
    ['absent', undefined],
    ['too short', 'short'],
    ['over 36 characters', 'a'.repeat(37)],
    ['with invalid characters', 'bad id with spaces!'],
  ])('[NFR-OPS-02] replaces an id that is %s with a UUIDv7', async (_case, header) => {
    const { app, lines } = buildApp();
    const req = request(app).get('/work');
    if (header !== undefined) void req.set('X-Request-Id', header);
    const res = await req;
    const id = res.headers['x-request-id'];
    expect(id).toMatch(UUID_V7);
    expect(linesFor(lines, String(id)).length).toBeGreaterThan(0);
  });
});

describe('[NFR-PRIV-01] log redaction', () => {
  it('[NFR-PRIV-01] redacts cookies, authorization, set-cookie and nested password, token, secret and phone values', async () => {
    const { app, lines } = buildApp();
    await request(app)
      .get('/work?token=xxxx-query-6&page=2')
      .set('Cookie', 'sid=xxxx-cookie-7')
      .set('Authorization', 'Bearer xxxx-auth-8');

    const text = JSON.stringify(lines);
    for (const value of [
      'xxxx-pw-1',
      '+910000000000',
      'xxxx-tok-2',
      'xxxx-sec-3',
      'xxxx-pw-4',
      'xxxx-cookie-5',
      'xxxx-query-6',
      'xxxx-cookie-7',
      'xxxx-auth-8',
    ]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('[Redacted]');
    // Non-sensitive data survives.
    expect(text).toContain('page=2');
    expect(text).toContain('inside handler');
  });
});

describe('[NFR-PRIV-01] logged URLs', () => {
  it('[NFR-PRIV-01] redacts only sensitive query values and keeps the rest exactly as sent', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/work?page=a%20b&token=xxxx-query-13');
    const urls = lines.map((l) => (l['req'] as { url?: string } | undefined)?.url).filter(Boolean);
    expect(urls).toContain('/work?page=a%20b&token=[Redacted]');
  });
});

describe('[NFR-PRIV-01] redaction of errors and deep values', () => {
  it('[NFR-PRIV-01] redacts sensitive properties carried by a logged error and its cause', () => {
    const { logger, lines } = createCapture();
    const inner = Object.assign(new Error('inner failure'), { token: 'xxxx-tok-10' });
    const error = Object.assign(new Error('outer failure', { cause: inner }), {
      headers: { authorization: 'Bearer xxxx-auth-9' },
      meta: { phone: '+910000000001' },
    });
    logger.error({ err: error }, 'failed');

    const text = JSON.stringify(lines);
    for (const value of ['xxxx-auth-9', '+910000000001', 'xxxx-tok-10']) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('outer failure');
    expect(text).toContain('inner failure');
  });

  it('[NFR-PRIV-01] redacts an error logged by the request logger when a handler throws', async () => {
    const { app, lines } = buildApp();
    const res = await request(app).get('/fail');
    expect(res.status).toBe(500);
    const text = JSON.stringify(lines);
    expect(text).toContain('upstream refused');
    expect(text).not.toContain('xxxx-auth-12');
  });

  it('[NFR-PRIV-01] never returns a sensitive value however deeply it is nested', () => {
    const { logger, lines } = createCapture();
    let nested: Record<string, unknown> = { password: 'xxxx-deep-11' };
    for (let i = 0; i < 20; i += 1) nested = { level: nested };
    logger.info({ nested }, 'deep');
    expect(JSON.stringify(lines)).not.toContain('xxxx-deep-11');
  });
});

describe('[NFR-PRIV-01] redaction parity with the config loader', () => {
  it('[NFR-PRIV-01] redacts keys that are or end in "key", but not words that merely end in it', () => {
    const { logger, lines } = createCapture();
    logger.info(
      {
        apiKey: 'xxxx-k1',
        api_key: 'xxxx-k2',
        'x-api-key': 'xxxx-k3',
        privateKey: 'xxxx-k4',
        key: 'xxxx-k5',
        nested: { SIGNING_KEY: 'xxxx-k6' },
        monkey: 'banana-visible',
        keyboard: 'keyboard-visible',
      },
      'keys',
    );
    const text = JSON.stringify(lines);
    for (const value of ['xxxx-k1', 'xxxx-k2', 'xxxx-k3', 'xxxx-k4', 'xxxx-k5', 'xxxx-k6']) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('banana-visible');
    expect(text).toContain('keyboard-visible');
  });

  it('[NFR-PRIV-01] redacts an x-api-key request header', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/work').set('X-Api-Key', 'xxxx-hdr-17');
    expect(JSON.stringify(lines)).not.toContain('xxxx-hdr-17');
  });

  it('[NFR-PRIV-01] masks the password of a credentialed URL in any logged string, error messages included', () => {
    const { logger, lines } = createCapture();
    logger.error(
      { err: new Error('connect failed for postgres://po_app:xxxx-pw-14@db:5432/po') },
      'database down',
    );
    logger.info(
      { target: 'https://svc:xxxx-pw-15@example.com/hook' },
      'calling postgres://po_owner:xxxx-pw-16@db/po',
    );
    const text = JSON.stringify(lines);
    for (const value of ['xxxx-pw-14', 'xxxx-pw-15', 'xxxx-pw-16'])
      expect(text).not.toContain(value);
    expect(text).toContain('postgres://po_app:[Redacted]@db:5432/po');
    expect(text).toContain('https://svc:[Redacted]@example.com/hook');
    expect(text).toContain('calling postgres://po_owner:[Redacted]@db/po');
  });
});

describe('[NFR-PRIV-01] objects that are not plain data', () => {
  it('[NFR-PRIV-01] fails closed: dates become ISO strings, errors are serialized, other instances are named only', () => {
    class ConnectionPool {
      password = 'xxxx-pw-18';
      host = 'db';
    }
    const { logger, lines } = createCapture();
    logger.info(
      {
        when: new Date(0),
        pool: new ConnectionPool(),
        items: [new Map([['secret', 'xxxx-map-20']])],
        nested: { failure: Object.assign(new Error('nested failure'), { token: 'xxxx-tok-19' }) },
      },
      'instances',
    );
    const line = lines.find((l) => l['msg'] === 'instances') ?? {};
    expect(line['when']).toBe('1970-01-01T00:00:00.000Z');
    expect(line['pool']).toBe('[Object ConnectionPool]');
    expect(line['items']).toEqual(['[Object Map]']);
    const text = JSON.stringify(line);
    expect(text).toContain('nested failure');
    for (const value of ['xxxx-pw-18', 'xxxx-tok-19', 'xxxx-map-20'])
      expect(text).not.toContain(value);
  });

  it('[NFR-PRIV-01] still logs the request and response fields of each request', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/work');
    const done = lines.find((l) => l['msg'] === 'request completed') ?? {};
    expect(done['req']).toMatchObject({ method: 'GET', url: '/work' });
    expect(done['res']).toMatchObject({ statusCode: 200 });
  });
});

describe('[NFR-PRIV-01] one-time link channel', () => {
  it('[NFR-PRIV-01] only the oneTimeLink path may print a token-shaped value', () => {
    const { logger, lines } = createCapture();
    logOneTimeLink(logger, `http://localhost:8080/set-password#${FAKE_TOKEN}`, 'admin created');
    expect(findTokenLeaks(lines)).toEqual([]);
    expect(JSON.stringify(lines)).toContain(FAKE_TOKEN);

    logger.info({ note: FAKE_TOKEN }, 'an ordinary line');
    expect(findTokenLeaks(lines)).toHaveLength(1);
  });
});
