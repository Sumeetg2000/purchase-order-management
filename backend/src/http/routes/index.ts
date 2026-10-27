import type { Mailer } from '../../mail/mailer.js';
import type { RouteDefinition } from '../define-route.js';
import { healthRoutes, type HealthDependencies } from './health.js';

/** What the routes need. The mailer is unused until slice 1's account routes. */
export type RouteDependencies = HealthDependencies & { mailer: Mailer };

/**
 * Every route the API serves. A test checks this is exactly the contract's operations
 * (@po/contracts OPERATIONS), so nothing is served undocumented.
 */
export function productionRoutes(deps: RouteDependencies): RouteDefinition[] {
  return [...healthRoutes(deps)];
}
