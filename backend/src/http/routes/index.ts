import { healthRoutes } from '../../health/routes.js';
import { createReadinessService, type HealthDependencies } from '../../health/service.js';
import type { MailDispatcher } from '../../mail/dispatcher.js';
import type { RouteDefinition } from '../define-route.js';

/** What the routes need. Mail is unused until slice 1's account routes. */
export type RouteDependencies = HealthDependencies & { mail: MailDispatcher };

/**
 * Every route the API serves, each area's routes given its services. A test checks this
 * is exactly the contract's operations (@po/contracts OPERATIONS), so nothing is served
 * undocumented.
 */
export function productionRoutes(deps: RouteDependencies): RouteDefinition[] {
  return [...healthRoutes(createReadinessService(deps))];
}
