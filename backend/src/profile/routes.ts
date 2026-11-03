import { OPERATIONS } from '@po/contracts';
import { defineRoute, type RouteDefinition } from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import type { ProfileService } from './service.js';

export function profileRoutes(profile: ProfileService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.getMe,
      handler: async (_req, res) => {
        res.json(await profile.getMe(authOf(res).userId));
      },
    }),
  ];
}
