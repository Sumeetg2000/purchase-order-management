// The web app's security headers (research R18, ADR-0018). deploy/nginx/default.conf sends
// exactly these on every location that serves the app; scripts/tests/security-headers
// pins it to this file, and the end-to-end tests check the live response.
//
// No 'unsafe-inline' anywhere: Vite's build emits no inline scripts, and styles come from
// CSS files (React Aria and React set styles through the CSSOM, which the CSP allows).
// HSTS is added where TLS terminates; this edge serves plain HTTP.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/** Header name → value. */
export const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  // Nothing about the page (one-time links included) leaks to other sites.
  'Referrer-Policy': 'no-referrer',
};
