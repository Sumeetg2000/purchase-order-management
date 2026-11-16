import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction, type TransactionOptions } from '../../src/db/transaction.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  type IdempotencyClaim,
} from '../../src/idempotency/repository.js';
import { requestHash } from '../../src/idempotency/request-hash.js';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

// Idempotent creates (research R5): the key is claimed in the create's own transaction, so
// the key, the order and its PO number commit or roll back together.

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

async function setup() {
  const db = trackDatabase(await createTestDatabase());
  const prisma = createPrismaClient({
    url: db.url('po_app'),
    poolSize: 4,
    connectionTimeoutMs: 2_000,
  });
  clients.push(prisma);
  const admin = await db.client('postgres');
  const userId = randomUUID();
  const otherUserId = randomUUID();
  await admin.query('BEGIN');
  await admin.query('SET LOCAL session_replication_role = replica');
  for (const id of [userId, otherUserId]) {
    await admin.query(
      `INSERT INTO users (id, name, email, roles, status) VALUES ($1, 'Buyer', $2, '{BUYER}', 'ACTIVE')`,
      [id, `${id}@example.local`],
    );
  }
  await admin.query('COMMIT');
  const options: TransactionOptions = {
    prisma,
    actor: { type: 'SYSTEM' },
    requestId: 'req-idem-0001',
    timeoutMs: 10_000,
    maxWaitMs: 2_000,
  };
  const keyCount = async () => {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM idempotency_keys`,
    );
    return Number(rows[0]?.n);
  };
  return { options, userId, otherUserId, keyCount };
}

const body = { vendorId: 'v', lines: [{ description: 'Bolts', quantity: 1, unitPrice: '1' }] };

describe('[NFR-CON-01] idempotency keys', () => {
  it('[NFR-CON-01] the first claim proceeds; after it completes, the same key and body replay its result', async () => {
    const { options, userId } = await setup();
    const key = randomUUID();
    const claim = {
      userId,
      operation: 'createOrder' as const,
      key,
      requestHash: requestHash(body),
    };

    const first = await withTransaction(options, async (tx) => {
      const result = await claimIdempotencyKey(tx, claim);
      if (result.kind === 'claimed') {
        await completeIdempotencyKey(tx, { ...claim, status: 201, response: { id: 'o1' } });
      }
      return result;
    });
    expect(first).toEqual({ kind: 'claimed' });

    const again = await withTransaction(options, (tx) => claimIdempotencyKey(tx, claim));
    expect(again).toEqual({ kind: 'replay', status: 201, response: { id: 'o1' } });
  });

  it('[NFR-CON-01] the same key with a different body is a reuse, not a replay', async () => {
    const { options, userId } = await setup();
    const key = randomUUID();
    const claim = {
      userId,
      operation: 'createOrder' as const,
      key,
      requestHash: requestHash(body),
    };
    await withTransaction(options, async (tx) => {
      await claimIdempotencyKey(tx, claim);
      await completeIdempotencyKey(tx, { ...claim, status: 201, response: { id: 'o1' } });
    });
    const other = { ...claim, requestHash: requestHash({ ...body, vendorId: 'w' }) };
    expect(await withTransaction(options, (tx) => claimIdempotencyKey(tx, other))).toEqual({
      kind: 'reused',
    });
  });

  it("[NFR-CON-01] keys are per user: another user's same key is a new claim", async () => {
    const { options, userId, otherUserId } = await setup();
    const key = randomUUID();
    const claim = {
      userId,
      operation: 'createOrder' as const,
      key,
      requestHash: requestHash(body),
    };
    await withTransaction(options, async (tx) => {
      await claimIdempotencyKey(tx, claim);
      await completeIdempotencyKey(tx, { ...claim, status: 201, response: { id: 'o1' } });
    });
    expect(
      await withTransaction(options, (tx) =>
        claimIdempotencyKey(tx, { ...claim, userId: otherUserId }),
      ),
    ).toEqual({ kind: 'claimed' });
  });

  it('[NFR-CON-01] a rolled-back claim leaves no key, so a retry starts afresh', async () => {
    const { options, userId, keyCount } = await setup();
    const claim = {
      userId,
      operation: 'createOrder' as const,
      key: randomUUID(),
      requestHash: requestHash(body),
    };
    await expect(
      withTransaction(options, async (tx) => {
        await claimIdempotencyKey(tx, claim);
        throw new Error('the create failed');
      }),
    ).rejects.toThrow('the create failed');
    expect(await keyCount()).toBe(0);
    expect(await withTransaction(options, (tx) => claimIdempotencyKey(tx, claim))).toEqual({
      kind: 'claimed',
    });
  });

  it('[NFR-CON-01] a concurrent claim of the same key waits for the first, then replays it', async () => {
    const { options, userId } = await setup();
    const claim = {
      userId,
      operation: 'createOrder' as const,
      key: randomUUID(),
      requestHash: requestHash(body),
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let claimed!: () => void;
    const firstClaimed = new Promise<void>((resolve) => (claimed = resolve));

    const first = withTransaction(options, async (tx) => {
      const result = await claimIdempotencyKey(tx, claim);
      claimed();
      await held;
      await completeIdempotencyKey(tx, { ...claim, status: 201, response: { id: 'o1' } });
      return result;
    });
    await firstClaimed;
    let secondDone = false;
    const second = withTransaction(options, (tx) => claimIdempotencyKey(tx, claim)).then(
      (result: IdempotencyClaim) => {
        secondDone = true;
        return result;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondDone).toBe(false);
    release();
    expect(await first).toEqual({ kind: 'claimed' });
    expect(await second).toEqual({ kind: 'replay', status: 201, response: { id: 'o1' } });
  });

  it('[NFR-CON-01] the request hash ignores key order and whitespace, never values', () => {
    expect(requestHash({ a: 1, b: [1, { c: 'x', d: null }] })).toEqual(
      requestHash({ b: [1, { d: null, c: 'x' }], a: 1 }),
    );
    expect(requestHash({ a: 1 })).not.toEqual(requestHash({ a: 2 }));
    expect(requestHash({ a: [1, 2] })).not.toEqual(requestHash({ a: [2, 1] }));
    expect(requestHash({ a: '1' })).not.toEqual(requestHash({ a: 1 }));
    expect(requestHash(body)).toHaveLength(32);
  });
});
