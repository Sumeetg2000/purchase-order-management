import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction, type AuditedTransaction } from '../../src/db/transaction.js';
import { issueToken, hashToken, type TokenPurpose } from '../../src/tokens/one-time.js';
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
  return { db, userId, issue };
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

  it('[FR-ACC-03] a RESET token expires 30 minutes after it is created, by the database clock', async () => {
    const { db, issue } = await setup();
    const { expiresAt } = await issue('RESET');
    const [row] = await tokenRows(db);
    expect(row?.purpose).toBe('RESET');
    expect((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)).toBe(30 * 60_000);
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
});
