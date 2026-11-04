import { OPERATIONS, type ChangePasswordBody, type LoginBody, type PageQuery } from '@po/contracts';
import { defineRoute, idParamOf, type RouteDefinition } from '../http/define-route.js';
import { authOf, refreshSessionOf } from '../http/middleware/authorize.js';
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
    defineRoute({
      ...OPERATIONS.changePassword,
      handler: async (req, res) => {
        const body = req.body as ChangePasswordBody;
        await sessions.changePassword(authOf(res), body, requestContext(req, res));
        res.status(204).end();
      },
    }),
    defineRoute({
      ...OPERATIONS.listSessions,
      handler: async (req, res) => {
        res.json(await sessions.listSessions(authOf(res), req.query as unknown as PageQuery));
      },
    }),
    defineRoute({
      ...OPERATIONS.revokeSession,
      handler: async (req, res) => {
        const { current } = await sessions.revokeSession(
          authOf(res),
          idParamOf(req),
          requestContext(req, res),
        );
        // Ending the calling session logs this browser out, like logout.
        if (current) clearSessionCookies(res);
        res.status(204).end();
      },
    }),
  ];
}
