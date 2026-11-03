import { etagFor, OPERATIONS, type UpdateUserBody, type UserListQuery } from '@po/contracts';
import {
  defineRoute,
  idParamOf,
  ifMatchVersionOf,
  type RouteDefinition,
} from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import { requestContext } from '../http/request-context.js';
import type { AdminUsersService } from './service.js';

export function adminUserRoutes(users: AdminUsersService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.listUsers,
      handler: async (req, res) => {
        res.json(await users.listUsers(req.query as unknown as UserListQuery));
      },
    }),
    defineRoute({
      ...OPERATIONS.getUser,
      handler: async (req, res) => {
        const user = await users.getUser(idParamOf(req));
        res.set('ETag', etagFor(user.version)).json(user);
      },
    }),
    defineRoute({
      ...OPERATIONS.updateUser,
      handler: async (req, res) => {
        const target = {
          id: idParamOf(req),
          version: ifMatchVersionOf(res),
          change: req.body as UpdateUserBody,
        };
        const user = await users.updateUser(authOf(res), target, requestContext(req, res));
        res.set('ETag', etagFor(user.version)).json(user);
      },
    }),
    defineRoute({
      ...OPERATIONS.sendUserPasswordReset,
      handler: async (req, res) => {
        await users.sendPasswordReset(authOf(res), idParamOf(req), requestContext(req, res));
        res.status(202).end();
      },
    }),
  ];
}
