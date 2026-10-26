import { OPERATIONS } from '@po/contracts';
import { createApp, type CreateAppOptions } from '../../src/http/app.js';

/**
 * createApp for tests whose routes go beyond the contract (to provoke validation, size,
 * origin and server errors). Every route not in OPERATIONS is registered as test-only;
 * contract routes are still checked against the contract. The server never uses this.
 */
export function createTestApp(options: Omit<CreateAppOptions, 'testOnlyOperations'>) {
  const testOnlyOperations = Object.fromEntries(
    options.routes
      .filter((route) => !Object.hasOwn(OPERATIONS, route.operationId))
      .map((route) => [route.operationId, route]),
  );
  return createApp({ ...options, testOnlyOperations });
}
