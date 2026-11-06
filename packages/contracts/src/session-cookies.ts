// The session cookie names and the CSRF header (ADR-0017 "Tokens and cookies"). Shared by
// the API, the OpenAPI document and the web app, which reads the CSRF cookie.

export const ACCESS_COOKIE = 'po_access';
export const REFRESH_COOKIE = 'po_refresh';
export const CSRF_COOKIE = 'po_csrf';

/** The header carrying the CSRF cookie's value on every state-changing request. */
export const CSRF_HEADER = 'X-CSRF-Token';

/** Methods that change nothing, so they need no CSRF header (ADR-0017). */
export const CSRF_EXEMPT_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;

/** Whether a request with this HTTP method must carry the CSRF header. */
export function requiresCsrf(method: string): boolean {
  return !(CSRF_EXEMPT_METHODS as readonly string[]).includes(method.toUpperCase());
}
