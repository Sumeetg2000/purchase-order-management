import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp, RouteRegistrationError } from '../../src/http/app.js';
import { defineRoute, type RouteDefinition } from '../../src/http/define-route.js';
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
