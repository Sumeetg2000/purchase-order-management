import { accessRequestRoutes } from '../../access-requests/routes.js';
import { createAccessRequestsService } from '../../access-requests/service.js';
import { accountsRoutes } from '../../accounts/routes.js';
import { createAccountsService } from '../../accounts/service.js';
import { adminUserRoutes } from '../../admin-users/routes.js';
import { createAdminUsersService } from '../../admin-users/service.js';
import { authRoutes } from '../../auth/routes.js';
import { createSessionService, type SessionServiceDependencies } from '../../auth/service.js';
import { healthRoutes } from '../../health/routes.js';
import { createReadinessService, type HealthDependencies } from '../../health/service.js';
import type { MailDispatcher } from '../../mail/dispatcher.js';
import { profileRoutes } from '../../profile/routes.js';
import { createProfileService } from '../../profile/service.js';
import { vendorRoutes } from '../../vendors/routes.js';
import { createVendorsService } from '../../vendors/service.js';
import type { RouteDefinition } from '../define-route.js';

/** What the routes' services need. */
export type RouteDependencies = HealthDependencies &
  SessionServiceDependencies &
  Parameters<typeof createAccountsService>[0] &
  Parameters<typeof createProfileService>[0] &
  Parameters<typeof createAdminUsersService>[0] &
  Parameters<typeof createAccessRequestsService>[0] &
  Parameters<typeof createVendorsService>[0] & {
    mail: MailDispatcher;
  };

/**
 * Every route the API serves, each area's routes given its services. A test checks this
 * is exactly the contract's operations (@po/contracts OPERATIONS), so nothing is served
 * undocumented.
 */
export function productionRoutes(deps: RouteDependencies): RouteDefinition[] {
  return [
    ...healthRoutes(createReadinessService(deps)),
    ...authRoutes(createSessionService(deps)),
    ...accountsRoutes(createAccountsService(deps)),
    ...profileRoutes(createProfileService(deps)),
    ...adminUserRoutes(createAdminUsersService(deps)),
    ...accessRequestRoutes(createAccessRequestsService(deps)),
    ...vendorRoutes(createVendorsService(deps)),
  ];
}
