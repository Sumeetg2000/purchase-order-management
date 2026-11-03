// The session cookie names and the CSRF header (ADR-0017 "Tokens and cookies"). Shared by
// the API, the OpenAPI document and the web app, which reads the CSRF cookie.

export const ACCESS_COOKIE = 'po_access';
export const REFRESH_COOKIE = 'po_refresh';
export const CSRF_COOKIE = 'po_csrf';

/** The header carrying the CSRF cookie's value on every state-changing request. */
export const CSRF_HEADER = 'X-CSRF-Token';
