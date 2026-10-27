import { createHash, randomBytes } from 'node:crypto';
import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';

// One-time tokens for set-password links, and from slice 1 email verification (ADR-0017,
// data-model.md). The token is 256 random bits, shown once; only its SHA-256 hash is
// stored, so a database dump can't be turned into working links. The expiry comes from
// the database clock: now() plus the purpose's lifetime.

export type TokenPurpose = 'RESET' | 'VERIFY_EMAIL';

/** How long a set-password (RESET) token stays valid (ADR-0017). */
export const RESET_TOKEN_LIFETIME_MINUTES = 30;

/** How long an email verification token stays valid (ADR-0017). */
export const VERIFY_EMAIL_TOKEN_LIFETIME_MINUTES = 24 * 60;

const LIFETIME_MINUTES: Readonly<Record<TokenPurpose, number>> = {
  RESET: RESET_TOKEN_LIFETIME_MINUTES,
  VERIFY_EMAIL: VERIFY_EMAIL_TOKEN_LIFETIME_MINUTES,
};

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export interface IssuedToken {
  /** The raw token, for the link. Never stored or logged outside the one-time link channel. */
  token: string;
  expiresAt: Date;
}

/**
 * Issues a token for a user and purpose, superseding that user's earlier unused token of
 * the same purpose, so only the newest link works. Overlapping issues for one user queue
 * on the user's row, so the later one sees and supersedes the earlier; a unique partial
 * index backs the rule up.
 */
export async function issueToken(
  tx: AuditedTransaction,
  userId: string,
  purpose: TokenPurpose,
): Promise<IssuedToken> {
  const token = randomBytes(32).toString('base64url');
  await tx.$executeRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  await tx.$executeRaw`
    UPDATE one_time_tokens SET superseded_at = now()
     WHERE user_id = ${userId}::uuid AND purpose = ${purpose}
       AND used_at IS NULL AND superseded_at IS NULL`;
  const [row] = await tx.$queryRaw<{ expires_at: Date }[]>`
    INSERT INTO one_time_tokens (id, user_id, purpose, token_hash, expires_at)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${purpose}, ${hashToken(token)},
            now() + make_interval(mins => ${LIFETIME_MINUTES[purpose]}))
    RETURNING expires_at`;
  if (!row) throw new Error('one_time_tokens insert returned no row');
  return { token, expiresAt: row.expires_at };
}
