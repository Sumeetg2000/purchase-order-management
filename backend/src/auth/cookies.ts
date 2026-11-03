import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from '@po/contracts';
import { parseCookie } from 'cookie';
import type { CookieOptions, Request, Response } from 'express';
import { SECOND_MS } from '../lib/time.js';

// The three session cookies (ADR-0017 "Tokens and cookies", research R2). No __Host- or
// __Secure- prefix: __Host- forbids a non-root path, and Firefox refuses prefixed
// cookies on http://localhost.

export { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from '@po/contracts';

/** The access cookie reaches the whole API; the refresh cookie only /api/auth. */
const ACCESS_PATH = '/api';
const REFRESH_PATH = '/api/auth';
/** The page reads the CSRF cookie, so it lives at the root. */
const CSRF_PATH = '/';

const BASE: CookieOptions = { secure: true, sameSite: 'strict' };

const PATHS = {
  [ACCESS_COOKIE]: { path: ACCESS_PATH, httpOnly: true },
  [REFRESH_COOKIE]: { path: REFRESH_PATH, httpOnly: true },
  // Not HttpOnly by design: the page sends it back as X-CSRF-Token.
  [CSRF_COOKIE]: { path: CSRF_PATH, httpOnly: false },
} as const;

export interface SessionCookies {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  /** The refresh token's remaining life; the access and CSRF cookies live exactly as long. */
  refreshMaxAgeSeconds: number;
}

export function setSessionCookies(res: Response, cookies: SessionCookies): void {
  const refreshMaxAge = cookies.refreshMaxAgeSeconds * SECOND_MS;
  res.cookie(ACCESS_COOKIE, cookies.accessToken, {
    ...BASE,
    ...PATHS[ACCESS_COOKIE],
    // As long as the refresh cookie, not its JWT's 15 minutes: a cookie that expired with
    // the token would vanish, and the next request would be UNAUTHENTICATED instead of
    // ACCESS_TOKEN_EXPIRED, so the silent refresh would never run (ADR-0017).
    maxAge: refreshMaxAge,
  });
  res.cookie(REFRESH_COOKIE, cookies.refreshToken, {
    ...BASE,
    ...PATHS[REFRESH_COOKIE],
    maxAge: refreshMaxAge,
  });
  res.cookie(CSRF_COOKIE, cookies.csrfToken, {
    ...BASE,
    ...PATHS[CSRF_COOKIE],
    maxAge: refreshMaxAge,
  });
}

/** Expires all three cookies, each on its own path (logout, revoking the current session). */
export function clearSessionCookies(res: Response): void {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE] as const) {
    res.clearCookie(name, { ...BASE, ...PATHS[name] });
  }
}

export interface RequestCookies {
  access?: string;
  refresh?: string;
  csrf?: string;
}

/** The session cookies a request carries; any other cookie is ignored. */
export function readCookies(req: Request): RequestCookies {
  const all = parseCookie(req.headers.cookie ?? '');
  const result: RequestCookies = {};
  const access = all[ACCESS_COOKIE];
  const refresh = all[REFRESH_COOKIE];
  const csrf = all[CSRF_COOKIE];
  if (access !== undefined) result.access = access;
  if (refresh !== undefined) result.refresh = refresh;
  if (csrf !== undefined) result.csrf = csrf;
  return result;
}
