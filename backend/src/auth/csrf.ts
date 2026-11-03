import { createHmac, timingSafeEqual } from 'node:crypto';

// The CSRF token (ADR-0017, research R7): base64url(HMAC-SHA256(CSRF_SECRET, session id)).
// It is bound to the session, so a cookie planted by another site can't forge it, and it
// carries no credential.

export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(sessionId)
    .digest('base64url');
}

/** Whether a presented X-CSRF-Token is the session's, compared in constant time. */
export function csrfTokenMatches(
  secret: string,
  sessionId: string,
  presented: string | undefined,
): boolean {
  if (!presented) return false;
  const expected = Buffer.from(csrfTokenFor(secret, sessionId));
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
