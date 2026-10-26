import type { RouteDefinition } from '../define-route.js';
import { healthRoutes, type HealthDependencies } from './health.js';

export type RouteDependencies = HealthDependencies;

/**
 * Every route the API serves. A test checks this is exactly the contract's operations
 * (@po/contracts OPERATIONS), so nothing is served undocumented.
 */
export function productionRoutes(deps: RouteDependencies): RouteDefinition[] {
  return [...healthRoutes(deps)];
}
