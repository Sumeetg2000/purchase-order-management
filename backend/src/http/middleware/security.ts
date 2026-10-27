import { AppError } from '@po/contracts';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * Security headers for the API's JSON responses (research R18). The API serves no HTML,
 * so its CSP allows nothing; nginx sets the app's own CSP.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
  });
}

/**
 * Same-origin deployment (ADR-0017): a request whose Origin is not APP_ORIGIN is refused
 * with 403 CSRF_REJECTED before any parsing or handler. No CORS headers are ever sent.
 * Slice 1 adds the CSRF token check here, under the same code.
 */
export function originGuard(appOrigin: string): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (origin !== undefined && origin !== appOrigin) {
      // Drain any unread body so the connection can carry the response.
      req.resume();
      next(new AppError('CSRF_REJECTED'));
      return;
    }
    next();
  };
}
