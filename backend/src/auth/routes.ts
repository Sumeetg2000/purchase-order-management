import { OPERATIONS, type LoginBody } from '@po/contracts';
import { defineRoute, type RouteDefinition } from '../http/define-route.js';
import { refreshSessionOf } from '../http/middleware/authorize.js';
import { requestContext } from '../http/request-context.js';
import { clearSessionCookies, setSessionCookies } from './cookies.js';
import type { SessionService } from './service.js';

export function authRoutes(sessions: SessionService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.login,
      handler: async (req, res) => {
        const { user, cookies } = await sessions.login(
          req.body as LoginBody,
          requestContext(req, res),
        );
        setSessionCookies(res, cookies);
        res.json(user);
      },
    }),
    defineRoute({
      ...OPERATIONS.refreshSession,
      handler: async (req, res) => {
        setSessionCookies(
          res,
          await sessions.refresh(refreshSessionOf(res), requestContext(req, res)),
        );
        res.status(204).end();
      },
    }),
    defineRoute({
      ...OPERATIONS.logout,
      handler: async (req, res) => {
        await sessions.logout(refreshSessionOf(res), requestContext(req, res));
        clearSessionCookies(res);
        res.status(204).end();
      },
    }),
    defineRoute({
      ...OPERATIONS.logoutAll,
      handler: async (req, res) => {
        await sessions.logoutAll(refreshSessionOf(res), requestContext(req, res));
        clearSessionCookies(res);
        res.status(204).end();
      },
    }),
  ];
}
