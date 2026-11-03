import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { csrfTokenFor, csrfTokenMatches } from '../../src/auth/csrf.js';

// The CSRF token is HMAC-SHA256(CSRF_SECRET, session id), base64url (research R7): bound to
// the session, so a planted cookie can't forge it.

const secret = Buffer.alloc(32, 9).toString('base64url');
const otherSecret = Buffer.alloc(32, 10).toString('base64url');

describe('[NFR-SEC-04] CSRF tokens', () => {
  it('[NFR-SEC-04] is a 256-bit base64url HMAC, stable for a session and different across sessions', () => {
    const session = randomUUID();
    const token = csrfTokenFor(secret, session);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfTokenFor(secret, session)).toBe(token);
    expect(csrfTokenFor(secret, randomUUID())).not.toBe(token);
    expect(csrfTokenFor(otherSecret, session)).not.toBe(token);
  });

  it('[NFR-SEC-04] matches only the token of the same session and secret', () => {
    const session = randomUUID();
    const token = csrfTokenFor(secret, session);
    expect(csrfTokenMatches(secret, session, token)).toBe(true);
    expect(csrfTokenMatches(secret, randomUUID(), token)).toBe(false);
    expect(csrfTokenMatches(otherSecret, session, token)).toBe(false);
  });

  it('[NFR-SEC-04] a missing, empty, truncated or overlong token never matches', () => {
    const session = randomUUID();
    const token = csrfTokenFor(secret, session);
    for (const presented of [undefined, '', token.slice(1), `${token}x`]) {
      expect(csrfTokenMatches(secret, session, presented), String(presented)).toBe(false);
    }
  });
});
