import { OPERATIONS, type ResetPasswordBody } from '@po/contracts';
import { defineRoute, type RouteDefinition } from '../http/define-route.js';
import { requestContext } from '../http/request-context.js';
import type { AccountsService } from './service.js';

export function accountsRoutes(accounts: AccountsService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.resetPassword,
      handler: async (req, res) => {
        await accounts.resetPassword(req.body as ResetPasswordBody, requestContext(req, res));
        res.status(204).end();
      },
    }),
  ];
}
