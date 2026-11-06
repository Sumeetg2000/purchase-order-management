import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction, type AuditedTransaction } from '../../src/db/transaction.js';
import {
  consumeToken,
  hashToken,
  issueToken,
  RESET_TOKEN_LIFETIME_MINUTES,
  type TokenPurpose,
} from '../../src/tokens/one-time.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { testLogger } from '../support/log-capture.js';
import { trackDatabase } from '../support/setup.js';

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

interface TokenRow {
  id: string;
  user_id: string;
  purpose: string;
  token_hash: Buffer;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  superseded_at: Date | null;
}

async function setup() {
  const db = trackDatabase(await createTestDatabase());
  const prisma = createPrismaClient({
    url: db.url('po_app'),
    poolSize: 2,
    connectionTimeoutMs: 2_000,
  });
  clients.push(prisma);
  const run = <T>(fn: (tx: AuditedTransaction) => Promise<T>) =>
    withTransaction(
      {
        prisma,
        actor: { type: 'SYSTEM' },
        requestId: 'req-tokens-0001',
        timeoutMs: 5_000,
        maxWaitMs: 2_000,
        logger: testLogger(),
      },
      fn,
    );
  const userId = await run(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO users (id, name, email, roles, status)
      VALUES (gen_random_uuid(), 'Token User', 'tokens@example.local', '{ADMIN}', 'ACTIVE')
      RETURNING id::text`;
    return row?.id ?? '';
  });
  const issue = (purpose: TokenPurpose = 'RESET') => run((tx) => issueToken(tx, userId, purpose));
  return { db, userId, issue, run };
}

async function tokenRows(db: TestDatabase): Promise<TokenRow[]> {
  const admin = await db.client('postgres');
  return (
    await admin.query<TokenRow>(
      'SELECT id, user_id::text, purpose, token_hash, created_at, expires_at, used_at, superseded_at FROM one_time_tokens ORDER BY created_at, id',
    )
  ).rows;
}

describe('[FR-ACC-03] one-time tokens', () => {
  it('[FR-ACC-03] a token is 256 random bits, and only its SHA-256 hash is stored', async () => {
    const { db, issue } = await setup();
    const { token } = await issue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const [row] = await tokenRows(db);
    const expected = createHash('sha256').update(token).digest();
    expect(row?.token_hash.equals(expected)).toBe(true);
    expect(hashToken(token).equals(expected)).toBe(true);

    const admin = await db.client('postgres');
    const { rows } = await admin.query<{ dump: string }>(
      'SELECT t::text AS dump FROM one_time_tokens t',
    );
    expect(rows[0]?.dump).not.toContain(token);
  });

  it('[FR-ACC-03] two tokens are never the same', async () => {
    const { issue } = await setup();
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i += 1) tokens.add((await issue()).token);
    expect(tokens.size).toBe(5);
  });

  it('[FR-ACC-03] a RESET token lives 30 minutes (FR-035)', () => {
    expect(RESET_TOKEN_LIFETIME_MINUTES).toBe(30);
  });

  it('[FR-ACC-03] a RESET token expires its lifetime after it is created, by the database clock', async () => {
    const { db, issue } = await setup();
    const { expiresAt } = await issue('RESET');
    const [row] = await tokenRows(db);
    expect(row?.purpose).toBe('RESET');
    expect((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)).toBe(
      RESET_TOKEN_LIFETIME_MINUTES * 60_000,
    );
    expect(expiresAt.getTime()).toBe(row?.expires_at.getTime());
  });

  it('[FR-ACC-03] a new token supersedes the earlier unused one of the same purpose only', async () => {
    const { db, issue } = await setup();
    await issue('RESET');
    await issue('VERIFY_EMAIL');
    await issue('RESET');
    const [firstReset, verify, secondReset] = await tokenRows(db);
    expect(firstReset?.superseded_at).toBeInstanceOf(Date);
    expect(verify?.superseded_at).toBeNull();
    expect(secondReset?.superseded_at).toBeNull();
  });

  it('[FR-ACC-03] two overlapping issues for the same user and purpose leave exactly one valid token', async () => {
    const { db, userId, run } = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markIssued: () => void = () => undefined;
    const issuedA = new Promise<void>((resolve) => {
      markIssued = resolve;
    });
    // A issues and holds its transaction open; B issues meanwhile; then A commits.
    const a = run(async (tx) => {
      await issueToken(tx, userId, 'RESET');
      markIssued();
      await gate;
    });
    await issuedA;
    const b = run((tx) => issueToken(tx, userId, 'RESET'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await Promise.all([a, b]);

    const open = (await tokenRows(db)).filter((t) => !t.used_at && !t.superseded_at);
    expect(open).toHaveLength(1);
  });

  it('[FR-ACC-03] a used token is not superseded later', async () => {
    const { db, issue } = await setup();
    await issue('RESET');
    const admin = await db.client('postgres');
    await admin.query('UPDATE one_time_tokens SET used_at = now()');
    await issue('RESET');
    const [used] = await tokenRows(db);
    expect(used?.used_at).toBeInstanceOf(Date);
    expect(used?.superseded_at).toBeNull();
  });

  it('[FR-ACC-03] po_app can only mark tokens used or superseded, never delete them; po_maintenance can only read and delete them', async () => {
    const { db, issue } = await setup();
    await issue();
    const app = await db.client('po_app');
    await expect(app.query('DELETE FROM one_time_tokens')).rejects.toMatchObject({
      code: '42501',
    });
    for (const column of ['expires_at', 'token_hash', 'user_id', 'purpose']) {
      await expect(
        app.query(`UPDATE one_time_tokens SET ${column} = ${column}`),
        column,
      ).rejects.toMatchObject({ code: '42501' });
    }
    const maintenance = await db.client('po_maintenance');
    await expect(
      maintenance.query('UPDATE one_time_tokens SET used_at = now()'),
    ).rejects.toMatchObject({
      code: '42501',
    });
    const deleted = await maintenance.query('DELETE FROM one_time_tokens');
    expect(deleted.rowCount).toBe(1);
  });

  it('[FR-ACC-03] the superseding and purge indexes exist as specified', async () => {
    const { db } = await setup();
    const admin = await db.client('postgres');
    const { rows } = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'one_time_tokens' AND indexname LIKE '%_idx' ORDER BY indexname`,
    );
    expect(
      rows.map((r) => [
        r.indexname,
        r.indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING btree /, '$1'),
      ]),
    ).toEqual([
      [
        'one_time_tokens_open_idx',
        'UNIQUE (user_id, purpose) WHERE ((used_at IS NULL) AND (superseded_at IS NULL))',
      ],
      ['one_time_tokens_purge_idx', '(COALESCE(used_at, superseded_at, expires_at))'],
    ]);
  });
});

describe('[FR-ACC-03] consuming a one-time token', () => {
  async function consumer() {
    const context = await setup();
    const consume = (token: string, purpose: TokenPurpose = 'RESET') =>
      context.run((tx) => consumeToken(tx, purpose, token));
    const admin = await context.db.client('postgres');
    /** Moves a token's expiry into the past, as the superuser (po_app can't). */
    const expire = (token: string) =>
      admin.query(
        `UPDATE one_time_tokens SET created_at = now() - interval '2 hours',
                                    expires_at = now() - interval '1 second'
          WHERE token_hash = $1`,
        [hashToken(token)],
      );
    return { ...context, consume, admin, expire };
  }

  it('[FR-ACC-03] a valid token is accepted once, for its user, then TOKEN_USED', async () => {
    const { issue, consume, userId } = await consumer();
    const { token } = await issue('RESET');
    expect(await consume(token)).toEqual({ ok: true, userId });
    expect(await consume(token)).toEqual({ ok: false, code: 'TOKEN_USED' });
  });

  it('[FR-ACC-03] an earlier token after a reissue is TOKEN_SUPERSEDED; the newest works', async () => {
    const { issue, consume, userId } = await consumer();
    const first = await issue('RESET');
    const second = await issue('RESET');
    expect(await consume(first.token)).toEqual({ ok: false, code: 'TOKEN_SUPERSEDED' });
    expect(await consume(second.token)).toEqual({ ok: true, userId });
  });

  it('[FR-ACC-03] a token past its expiry is TOKEN_EXPIRED and stays unused', async () => {
    const { issue, consume, expire, db } = await consumer();
    const { token } = await issue('RESET');
    await expire(token);
    expect(await consume(token)).toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
    expect((await tokenRows(db))[0]?.used_at).toBeNull();
  });

  it('[FR-ACC-03] an unknown, purged or wrong-purpose token is INVALID_TOKEN', async () => {
    const { issue, consume, admin } = await consumer();
    expect(await consume('not-a-token')).toEqual({ ok: false, code: 'INVALID_TOKEN' });

    const verify = await issue('VERIFY_EMAIL');
    expect(await consume(verify.token, 'RESET')).toEqual({ ok: false, code: 'INVALID_TOKEN' });

    const purged = await issue('RESET');
    await admin.query('DELETE FROM one_time_tokens WHERE token_hash = $1', [
      hashToken(purged.token),
    ]);
    expect(await consume(purged.token)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
  });

  it('[FR-ACC-03] used beats superseded beats expired: a used, expired token is TOKEN_USED', async () => {
    const { issue, consume, expire } = await consumer();
    const used = await issue('RESET');
    await consume(used.token);
    await expire(used.token);
    expect(await consume(used.token)).toEqual({ ok: false, code: 'TOKEN_USED' });

    const superseded = await issue('RESET');
    await issue('RESET');
    await expire(superseded.token);
    expect(await consume(superseded.token)).toEqual({ ok: false, code: 'TOKEN_SUPERSEDED' });
  });

  it('[FR-ACC-03] two concurrent uses of one token: exactly one succeeds, the other is TOKEN_USED', async () => {
    const { issue, run, userId } = await consumer();
    const { token } = await issue('RESET');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markConsumed: () => void = () => undefined;
    const consumedA = new Promise<void>((resolve) => {
      markConsumed = resolve;
    });
    // A consumes and holds its transaction (and the row lock) open; B tries meanwhile.
    const a = run(async (tx) => {
      const result = await consumeToken(tx, 'RESET', token);
      markConsumed();
      await gate;
      return result;
    });
    await consumedA;
    const b = run((tx) => consumeToken(tx, 'RESET', token));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    expect(await Promise.all([a, b])).toEqual([
      { ok: true, userId },
      { ok: false, code: 'TOKEN_USED' },
    ]);
  });
});
