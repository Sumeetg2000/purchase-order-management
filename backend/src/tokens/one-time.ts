import { createHash, randomBytes } from 'node:crypto';
import type { ErrorCode } from '@po/contracts';
import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';

// One-time tokens for set-password links, and from slice 1 email verification (ADR-0017,
// data-model.md). The token is 256 random bits, shown once; only its SHA-256 hash is
// stored, so a database dump can't be turned into working links. The expiry comes from
// the database clock: now() plus the purpose's lifetime, and expiry is checked against it.

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

/** Why a presented token can't be used; each is its own API code (ADR-0017, 2026-11-03). */
export type TokenFailure = Extract<
  ErrorCode,
  'TOKEN_USED' | 'TOKEN_SUPERSEDED' | 'TOKEN_EXPIRED' | 'INVALID_TOKEN'
>;

export type ConsumedToken = { ok: true; userId: string } | { ok: false; code: TokenFailure };

/**
 * Uses a token for its purpose, once. The row is locked first, so two concurrent uses of
 * one token can't both succeed: the second sees it used. A failure leaves the token as it
 * was. Precedence: used, then superseded, then expired; a token with no row for this
 * purpose (a typo, the wrong page, or purged) is INVALID_TOKEN.
 *
 * Its user's row is locked before the token's, the order issueToken takes them in, so a
 * use and an issue for the same user queue instead of deadlocking.
 */
export async function consumeToken(
  tx: AuditedTransaction,
  purpose: TokenPurpose,
  token: string,
): Promise<ConsumedToken> {
  const [owner] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM users
     WHERE id = (SELECT user_id FROM one_time_tokens
                  WHERE token_hash = ${hashToken(token)} AND purpose = ${purpose})
       FOR UPDATE`;
  if (!owner) return { ok: false, code: 'INVALID_TOKEN' };
  const [row] = await tx.$queryRaw<
    { id: string; user_id: string; used: boolean; superseded: boolean; expired: boolean }[]
  >`
    SELECT id::text, user_id::text, used_at IS NOT NULL AS used,
           superseded_at IS NOT NULL AS superseded, expires_at <= now() AS expired
      FROM one_time_tokens
     WHERE token_hash = ${hashToken(token)} AND purpose = ${purpose}
       FOR UPDATE`;
  if (!row) return { ok: false, code: 'INVALID_TOKEN' };
  if (row.used) return { ok: false, code: 'TOKEN_USED' };
  if (row.superseded) return { ok: false, code: 'TOKEN_SUPERSEDED' };
  if (row.expired) return { ok: false, code: 'TOKEN_EXPIRED' };
  await tx.$executeRaw`UPDATE one_time_tokens SET used_at = now() WHERE id = ${row.id}::uuid`;
  return { ok: true, userId: row.user_id };
}
