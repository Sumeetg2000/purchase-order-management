import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATIONS } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppPrismaClient } from '../../src/db/client.js';
import { createApp, RouteRegistrationError } from '../../src/http/app.js';
import { defineRoute, type RouteDefinition } from '../../src/http/define-route.js';
import { productionRoutes } from '../../src/http/routes/index.js';
import { CaptureMailer } from '../../src/mail/capture.js';
import { testLogger } from '../support/log-capture.js';

const health = defineRoute({
  ...OPERATIONS.getHealth,
  handler: (_req, res) => {
    res.json({ status: 'ok' });
  },
});

const appOptions = { logger: testLogger(), appOrigin: 'http://localhost:8080' };

describe('[NFR-AUTH-01] route registration (deny by default)', () => {
  it('registers a public route that declares access and responses', () => {
    expect(() => createApp({ ...appOptions, routes: [health] })).not.toThrow();
  });

  it('refuses to start when a route declares no access', () => {
    const withoutAccess: Record<string, unknown> = { ...health };
    delete withoutAccess['access'];
    const route = withoutAccess as unknown as RouteDefinition;
    expect(() => createApp({ ...appOptions, routes: [route] })).toThrow(RouteRegistrationError);
    expect(() => createApp({ ...appOptions, routes: [route] })).toThrow(/access/);
  });

  it('refuses an access value that is not a known level', () => {
    const route = { ...health, access: 'everyone' } as unknown as RouteDefinition;
    expect(() => createApp({ ...appOptions, routes: [route] })).toThrow(/access/);
  });

  it('refuses a route that cannot be documented in the OpenAPI registry', () => {
    const route = { ...health, responses: {} } as unknown as RouteDefinition;
    expect(() => createApp({ ...appOptions, routes: [route] })).toThrow(/OpenAPI/);
  });

  it('refuses duplicate operation ids and duplicate method and path pairs', () => {
    const copy = { ...health, path: '/other' };
    expect(() => createApp({ ...appOptions, routes: [health, copy] })).toThrow(/operationId/);
    const samePath = { ...health, operationId: 'getHealthAgain' };
    expect(() => createApp({ ...appOptions, routes: [health, samePath] })).toThrow(/GET \/healthz/);
  });
});

describe('[NFR-API-01] routes follow the contract', () => {
  it('[NFR-API-01] refuses a route that claims a contract operation with another method or path', () => {
    const moved = { ...health, path: '/live' };
    expect(() => createApp({ ...appOptions, routes: [moved] })).toThrow(/contract/);
    const otherMethod = { ...health, method: 'post' as const };
    expect(() => createApp({ ...appOptions, routes: [otherMethod] })).toThrow(/contract/);
  });

  it('[NFR-API-01] refuses a route that spreads a contract operation but changes what it documents', () => {
    const changed: RouteDefinition[] = [
      { ...health, request: { query: z.strictObject({ verbose: z.string() }) } },
      { ...health, responses: { 200: z.object({ status: z.string() }) } },
      { ...health, errors: ['NOT_FOUND'] },
      { ...health, summary: 'Something else' },
    ];
    for (const route of changed) {
      expect(() => createApp({ ...appOptions, routes: [route] })).toThrow(/contract/);
    }
  });

  it('[NFR-API-01] the production routes are exactly the contract operations', () => {
    const routes = productionRoutes({
      prisma: {} as AppPrismaClient,
      expectedMigrations: [],
      mailer: new CaptureMailer(),
    });
    const served = routes.map((r) => `${r.operationId} ${r.method} ${r.path}`).sort();
    const documented = Object.values(OPERATIONS)
      .map((o) => `${o.operationId} ${o.method} ${o.path}`)
      .sort();
    expect(served).toEqual(documented);
  });
});

describe('[NFR-API-01] only contract operations are served', () => {
  const secret = defineRoute({
    method: 'get',
    path: '/secret-admin',
    operationId: 'notInContract',
    summary: 'not in the contract',
    access: 'public',
    responses: { 200: z.object({}) },
    handler: (_req, res) => {
      res.json({});
    },
  });

  it('[NFR-API-01] refuses a route whose operationId is not in the contract', () => {
    expect(() => createApp({ ...appOptions, routes: [secret] })).toThrow(RouteRegistrationError);
    expect(() => createApp({ ...appOptions, routes: [secret] })).toThrow(/notInContract/);
  });

  it('[NFR-API-01] serves a test-only route only through an explicit test-only registry', () => {
    expect(() =>
      createApp({
        ...appOptions,
        routes: [secret],
        testOnlyOperations: { notInContract: secret },
      }),
    ).not.toThrow();
  });

  it('[NFR-API-01] a test-only registry cannot name a contract operation', () => {
    expect(() =>
      createApp({ ...appOptions, routes: [health], testOnlyOperations: { getHealth: health } }),
    ).toThrow(/test-only.*getHealth/);
  });

  it('[NFR-API-01] no source file outside app.ts mentions the test-only registry', () => {
    const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
    const users = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.startsWith('generated'))
      .filter((file) => readFileSync(join(srcDir, file), 'utf8').includes('testOnlyOperations'));
    expect(users).toEqual([join('http', 'app.ts')]);
  });
});
