import type { RouteDefinition } from '../../src/http/define-route.js';
import { createApp, type CreateAppOptions } from '../../src/http/app.js';

export interface TestAppOptions extends Omit<CreateAppOptions, 'testOnlyOperations' | 'routes'> {
  /** Routes that serve contract operations, checked against the contract as in production. */
  routes?: readonly RouteDefinition[];
  /** Routes a test adds to provoke errors the real routes can't; named here explicitly. */
  testOnlyRoutes?: readonly RouteDefinition[];
}

/** createApp for tests that need routes beyond the contract. The server never uses this. */
export function createTestApp({ routes = [], testOnlyRoutes = [], ...options }: TestAppOptions) {
  return createApp({
    ...options,
    routes: [...routes, ...testOnlyRoutes],
    testOnlyOperations: Object.fromEntries(
      testOnlyRoutes.map((route) => [route.operationId, route]),
    ),
  });
}
