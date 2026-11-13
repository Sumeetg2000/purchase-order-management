import type { Prisma } from '../generated/prisma/client.js';
import type { AuditedTransaction } from '../db/transaction.js';

// Idempotency keys (research R5). A create claims its key first, in its own transaction,
// and stores its response before committing, so the key commits or rolls back with the
// order. A second request with the same key waits on the first's uncommitted row (the
// primary key), then sees its stored result.

export type IdempotentOperation = 'createOrder';

export interface IdempotencyKeyRef {
  userId: string;
  operation: IdempotentOperation;
  key: string;
}

export type IdempotencyClaim =
  { kind: 'claimed' } | { kind: 'replay'; status: number; response: unknown } | { kind: 'reused' };

export async function claimIdempotencyKey(
  tx: AuditedTransaction,
  ref: IdempotencyKeyRef & { requestHash: Buffer },
): Promise<IdempotencyClaim> {
  const inserted = await tx.$queryRaw<unknown[]>`
    INSERT INTO idempotency_keys (user_id, operation, key, request_hash)
    VALUES (${ref.userId}::uuid, ${ref.operation}, ${ref.key}::uuid, ${ref.requestHash})
    ON CONFLICT DO NOTHING
    RETURNING 1`;
  if (inserted.length > 0) return { kind: 'claimed' };

  const [stored] = await tx.$queryRaw<
    { same: boolean; status: number | null; response: Prisma.JsonValue }[]
  >`
    SELECT request_hash = ${ref.requestHash} AS same, status, response
      FROM idempotency_keys
     WHERE user_id = ${ref.userId}::uuid AND operation = ${ref.operation}
       AND key = ${ref.key}::uuid`;
  if (!stored) throw new Error('idempotency key vanished between its insert and its read');
  if (!stored.same) return { kind: 'reused' };
  // A committed key always has its response: it is stored in the claiming transaction.
  if (stored.status === null) throw new Error('idempotency key committed without a response');
  return { kind: 'replay', status: stored.status, response: stored.response };
}

export async function completeIdempotencyKey(
  tx: AuditedTransaction,
  ref: IdempotencyKeyRef & { status: number; response: unknown },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE idempotency_keys
       SET status = ${ref.status}::smallint, response = ${JSON.stringify(ref.response)}::jsonb
     WHERE user_id = ${ref.userId}::uuid AND operation = ${ref.operation}
       AND key = ${ref.key}::uuid`;
}
