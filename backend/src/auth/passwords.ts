import { readFileSync } from 'node:fs';
import type { FieldError } from '@po/contracts';
import { argon2id, hash, needsRehash as argon2NeedsRehash, verify } from 'argon2';

// Password hashing and the common-password check (ADR-0017, research R3 and R4). The
// length rule is the shared schema's (@po/contracts passwordSchema); the common-password
// list stays on the server.

/** OWASP's minimum argon2id profile: 19 MiB, 2 iterations, 1 lane. */
export const ARGON2_MEMORY_KIB = 19 * 1024;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;

const PROFILE = {
  memoryCost: ARGON2_MEMORY_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, { type: argon2id, ...PROFILE });
}

/** Whether the password matches the stored hash. A malformed hash matches nothing. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** Whether a stored hash was made with another profile, so login should rehash it. */
export function needsRehash(storedHash: string): boolean {
  return argon2NeedsRehash(storedHash, PROFILE);
}

/**
 * The bundled list (lower-cased entries, `#` comments), read once when the module loads:
 * at API startup, so a missing list stops the start rather than failing a request, and no
 * request blocks on reading it.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#')),
);

/** PASSWORD_TOO_COMMON at `path` when the password is on the list, whatever its case. */
export function commonPasswordError(path: string, password: string): FieldError | undefined {
  return COMMON_PASSWORDS.has(password.toLowerCase())
    ? { path, code: 'PASSWORD_TOO_COMMON' }
    : undefined;
}
