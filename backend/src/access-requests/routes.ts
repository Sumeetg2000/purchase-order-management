import { OPERATIONS, type AccessRequestListQuery, type DismissBody } from '@po/contracts';
import { defineRoute, idParamOf, type RouteDefinition } from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import { requestContext } from '../http/request-context.js';
import type { AccessRequestsService } from './service.js';

export function accessRequestRoutes(requests: AccessRequestsService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.listAccessRequests,
      handler: async (req, res) => {
        res.json(await requests.list(req.query as unknown as AccessRequestListQuery));
      },
    }),
    defineRoute({
      ...OPERATIONS.dismissAccessRequest,
      handler: async (req, res) => {
        const { note } = req.body as DismissBody;
        const dismissal = { id: idParamOf(req), note };
        res.json(await requests.dismiss(authOf(res), dismissal, requestContext(req, res)));
      },
    }),
  ];
}
