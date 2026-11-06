import { OPERATIONS, type AccessRequestBody, type UpdateMeBody } from '@po/contracts';
import { defineRoute, type RouteDefinition } from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import { requestContext } from '../http/request-context.js';
import type { ProfileService } from './service.js';

export function profileRoutes(profile: ProfileService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.getMe,
      handler: async (_req, res) => {
        res.json(await profile.getMe(authOf(res).userId));
      },
    }),
    defineRoute({
      ...OPERATIONS.updateMe,
      handler: async (req, res) => {
        const { name } = req.body as UpdateMeBody;
        res.json(await profile.updateMe(authOf(res), name, requestContext(req, res)));
      },
    }),
    defineRoute({
      ...OPERATIONS.getOwnAccessRequest,
      handler: async (_req, res) => {
        res.json(await profile.getOwnAccessRequest(authOf(res).userId));
      },
    }),
    defineRoute({
      ...OPERATIONS.sendAccessRequest,
      handler: async (req, res) => {
        const { message } = req.body as AccessRequestBody;
        res.json(await profile.sendAccessRequest(authOf(res), message, requestContext(req, res)));
      },
    }),
  ];
}
