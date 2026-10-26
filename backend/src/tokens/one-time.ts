import { createHash, randomBytes } from 'node:crypto';
import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';

// One-time tokens for set-password links, and from slice 1 email verification (ADR-0017,
// data-model.md). The token is 256 random bits, shown once; only its SHA-256 hash is
// stored, so a database dump can't be turned into working links.

export type TokenPurpose = 'RESET' | 'VERIFY_EMAIL';

/** How long a token stays valid, as a PostgreSQL interval (computed by the database clock). */
const LIFETIME: Readonly<Record<TokenPurpose, string>> = {
  RESET: '30 minutes',
  VERIFY_EMAIL: '24 hours',
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
 * the same purpose, so only the newest link works.
 */
export async function issueToken(
  tx: AuditedTransaction,
  userId: string,
  purpose: TokenPurpose,
): Promise<IssuedToken> {
  const token = randomBytes(32).toString('base64url');
  await tx.$executeRaw`
    UPDATE one_time_tokens SET superseded_at = now()
     WHERE user_id = ${userId}::uuid AND purpose = ${purpose}
       AND used_at IS NULL AND superseded_at IS NULL`;
  const [row] = await tx.$queryRaw<{ expires_at: Date }[]>`
    INSERT INTO one_time_tokens (id, user_id, purpose, token_hash, expires_at)
    VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${purpose}, ${hashToken(token)},
            now() + ${LIFETIME[purpose]}::interval)
    RETURNING expires_at`;
  if (!row) throw new Error('one_time_tokens insert returned no row');
  return { token, expiresAt: row.expires_at };
}
