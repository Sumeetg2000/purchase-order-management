// What the suite-wide checks treat as a secret: a token, a password hash, or the password
// the account tests use. Log lines, API response bodies and audit rows must hold none.

/** The password the account harness gives every seeded user. */
export const PASSWORD = 'correct horse battery staple';

/**
 * A 256-bit token in base64url is 43 characters. Ids (UUIDs are 36), hostnames and path
 * segments are shorter, so a longer run of these characters is treated as a token.
 */
export const TOKEN_SHAPED = /[A-Za-z0-9_-]{43,}/;

/** An encoded argon2 hash (auth/passwords.ts), whichever variant. */
export const PASSWORD_HASH = /\$argon2(?:id|i|d)\$/;

export type SecretKind = 'token' | 'password hash' | 'password';

/** The kinds of secret found in a value, serialised as JSON. */
export function secretsIn(value: unknown): SecretKind[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const found: SecretKind[] = [];
  if (TOKEN_SHAPED.test(text)) found.push('token');
  if (PASSWORD_HASH.test(text)) found.push('password hash');
  if (text.includes(PASSWORD)) found.push('password');
  return found;
}
