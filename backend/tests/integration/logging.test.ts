import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../src/http/app.js';
import { defineRoute } from '../../src/http/define-route.js';
import { logOneTimeLink } from '../../src/observability/logger.js';
import { createCapture, findTokenLeaks, type LogLine } from '../support/log-capture.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Low-entropy stand-in for a 256-bit base64url token (43 characters).
const FAKE_TOKEN = 'x'.repeat(43);

function buildApp() {
  const capture = createCapture();
  const app = createApp({
    logger: capture.logger,
    appOrigin: 'http://localhost:8080',
    routes: [
      defineRoute({
        method: 'get',
        path: '/work',
        operationId: 'testWork',
        summary: 'test only',
        access: 'public',
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

  it.each([
    ['absent', undefined],
    ['too short', 'short'],
    ['over 64 characters', 'a'.repeat(65)],
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

describe('[NFR-PRIV-01] redaction of deep values', () => {
  it('[NFR-PRIV-01] never returns a sensitive value however deeply it is nested', () => {
    const { logger, lines } = createCapture();
    let nested: Record<string, unknown> = { password: 'xxxx-deep-11' };
    for (let i = 0; i < 20; i += 1) nested = { level: nested };
    logger.info({ nested }, 'deep');
    expect(JSON.stringify(lines)).not.toContain('xxxx-deep-11');
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
