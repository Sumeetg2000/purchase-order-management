import { OPERATIONS } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppPrismaClient } from '../../src/db/client.js';
import { createApp, RouteRegistrationError } from '../../src/http/app.js';
import { defineRoute, type RouteDefinition } from '../../src/http/define-route.js';
import { productionRoutes } from '../../src/http/routes/index.js';
import { testLogger } from '../support/log-capture.js';

const health = defineRoute({
  method: 'get',
  path: '/healthz',
  operationId: 'getHealth',
  summary: 'Liveness',
  access: 'public',
  responses: { 200: z.object({ status: z.literal('ok') }) },
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

  it('[NFR-API-01] the production routes are exactly the contract operations', () => {
    const routes = productionRoutes({
      prisma: {} as AppPrismaClient,
      expectedMigrations: [],
    });
    const served = routes.map((r) => `${r.operationId} ${r.method} ${r.path}`).sort();
    const documented = Object.values(OPERATIONS)
      .map((o) => `${o.operationId} ${o.method} ${o.path}`)
      .sort();
    expect(served).toEqual(documented);
  });
});
