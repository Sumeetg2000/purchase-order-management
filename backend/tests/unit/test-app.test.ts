import { OPERATIONS } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRoute } from '../../src/http/define-route.js';
import { testLogger } from '../support/log-capture.js';
import { createTestApp } from '../support/test-app.js';

const appOptions = { logger: testLogger(), appOrigin: 'http://localhost:8080' };
const noop = defineRoute({
  method: 'get',
  path: '/test-noop',
  operationId: 'testNoop',
  summary: 'test only',
  access: 'public',
  responses: { 200: z.object({}) },
  handler: (_req, res) => {
    res.json({});
  },
});

describe('[NFR-API-01] test apps name their test-only routes', () => {
  it('[NFR-API-01] a route outside the contract is refused unless it is passed as test-only', () => {
    expect(() => createTestApp({ ...appOptions, routes: [noop] })).toThrow(/not in the contract/);
    expect(() => createTestApp({ ...appOptions, testOnlyRoutes: [noop] })).not.toThrow();
  });

  it('[NFR-API-01] a misspelled contract route is refused, not served as test-only', () => {
    const misspelled = { ...noop, ...OPERATIONS.getHealth, operationId: 'getHelth' };
    expect(() => createTestApp({ ...appOptions, routes: [misspelled] })).toThrow(/getHelth/);
  });
});
