// One-time links point at the web app with the token in the fragment (ADR-0017):
// browsers never send a fragment to a server, so the token can't reach an access log or
// a Referer header. The page reads location.hash and POSTs the token. Tokens are
// base64url, so they need no escaping.

function oneTimeLink(appOrigin: string, page: string, token: string): string {
  const url = new URL(page, appOrigin);
  url.hash = `token=${token}`;
  return url.toString();
}

/** The set-password (and reset) page. */
export function setPasswordLink(appOrigin: string, token: string): string {
  return oneTimeLink(appOrigin, '/reset-password', token);
}

/** The email verification page. */
export function verifyEmailLink(appOrigin: string, token: string): string {
  return oneTimeLink(appOrigin, '/verify-email', token);
}
