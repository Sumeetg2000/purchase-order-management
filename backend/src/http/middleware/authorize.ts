import { AppError, CSRF_HEADER, requiresCsrf, ROLE, type Access } from '@po/contracts';
import type { RequestHandler, Response } from 'express';
import { readCookies } from '../../auth/cookies.js';
import { csrfTokenMatches } from '../../auth/csrf.js';
import type { AuthenticatedUser, AuthService, RefreshSession } from '../../auth/service.js';

// The authorize step (research R1, R7; ADR-0004 check precedence, amended 2026-11-03).
// One middleware per guarded route, before the body is read or validated:
//   401, then CSRF on state changes, then 403 NO_ROLE_ASSIGNED, then 403 FORBIDDEN for a
//   user without the route's access level: they can't use the route whatever the input.
// Order-level checks (ownership, separation of duties) are the services' own. The global
// origin guard has already refused a cross-origin request.

export interface AuthDependencies {
  service: AuthService;
  /** CSRF_SECRET: the CSRF token is HMAC(secret, session id). */
  csrfSecret: string;
}

const AUTH_KEY = 'auth';
const REFRESH_KEY = 'refreshSession';

/** Access levels that serve only users holding a role: no role is NO_ROLE_ASSIGNED. */
const ROLE_LEVELS: ReadonlySet<Access> = new Set(['admin']);

function checkCsrf(
  deps: AuthDependencies,
  method: string,
  sessionId: string,
  header: string | undefined,
) {
  if (!requiresCsrf(method)) return;
  if (!csrfTokenMatches(deps.csrfSecret, sessionId, header)) throw new AppError('CSRF_REJECTED');
}

/** Whether a user's roles satisfy an access level. */
function allowed(access: Access, user: AuthenticatedUser): boolean {
  switch (access) {
    case 'public':
    case 'refresh':
    case 'user':
      return true;
    case 'no-role':
      return user.roles.length === 0;
    case 'admin':
      return user.roles.includes(ROLE.ADMIN);
  }
}

export function authenticate(access: Access, deps: AuthDependencies): RequestHandler {
  return (req, res, next) => {
    const run = async () => {
      const cookies = readCookies(req);
      const csrfHeader = req.get(CSRF_HEADER);
      if (access === 'refresh') {
        const session = await deps.service.identifyRefreshSession(cookies.refresh);
        checkCsrf(deps, req.method, session.sessionId, csrfHeader);
        res.locals[REFRESH_KEY] = session;
        return;
      }
      const user = await deps.service.authenticate(cookies.access);
      checkCsrf(deps, req.method, user.sessionId, csrfHeader);
      if (ROLE_LEVELS.has(access) && user.roles.length === 0) {
        throw new AppError('NO_ROLE_ASSIGNED');
      }
      if (!allowed(access, user)) throw new AppError('FORBIDDEN');
      res.locals[AUTH_KEY] = user;
    };
    run().then(
      () => {
        next();
      },
      (error: unknown) => {
        // Drain any unread body so the connection can carry the response.
        req.resume();
        next(error);
      },
    );
  };
}

/** The authenticated user of a request on a user, no-role or admin route. */
export function authOf(res: Response): AuthenticatedUser {
  const user = res.locals[AUTH_KEY] as AuthenticatedUser | undefined;
  if (!user) throw new Error('authOf called on a route that is not authenticated');
  return user;
}

/** The refresh session of a request on a refresh route. */
export function refreshSessionOf(res: Response): RefreshSession {
  const session = res.locals[REFRESH_KEY] as RefreshSession | undefined;
  if (!session) throw new Error('refreshSessionOf called on a route that is not a refresh route');
  return session;
}
