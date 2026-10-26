import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BootstrapError, runBootstrap, type BootstrapOptions } from '../../src/bootstrap/run.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { createCapture } from '../support/log-capture.js';
import { trackDatabase } from '../support/setup.js';

const APP_ORIGIN = 'http://localhost:8080';
const ADMIN = { email: 'first.admin@example.local', name: 'First Admin' };

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

function prismaFor(db: TestDatabase): AppPrismaClient {
  const prisma = createPrismaClient({
    url: db.url('po_app'),
    poolSize: 2,
    connectionTimeoutMs: 2_000,
  });
  clients.push(prisma);
  return prisma;
}

async function setup() {
  const db = trackDatabase(await createTestDatabase());
  const capture = createCapture();
  const options = (overrides: Partial<BootstrapOptions> = {}): BootstrapOptions => ({
    prisma: prismaFor(db),
    email: ADMIN.email,
    name: ADMIN.name,
    appOrigin: APP_ORIGIN,
    logger: capture.logger,
    ...overrides,
  });
  const links = () => capture.lines.filter((line) => line['oneTimeLink'] === true);
  return { db, options, links };
}

async function query<T extends Record<string, unknown>>(db: TestDatabase, sql: string) {
  const admin = await db.client('postgres');
  return (await admin.query<T>(sql)).rows;
}

const admins = (db: TestDatabase) =>
  query<{ email: string; status: string; password_hash: string | null }>(
    db,
    `SELECT email, status, password_hash FROM users WHERE roles = '{ADMIN}'`,
  );

describe('[FR-ADM-04] admin bootstrap', () => {
  it('[FR-ADM-04] with no admin, creates one active admin without a password, a RESET token, a SYSTEM audit entry and one link', async () => {
    const { db, options, links } = await setup();
    expect(await runBootstrap(options())).toBe('created');

    expect(await admins(db)).toEqual([
      { email: ADMIN.email, status: 'ACTIVE', password_hash: null },
    ]);
    const tokens = await query<{ purpose: string; token_hash: Buffer }>(
      db,
      'SELECT purpose, token_hash FROM one_time_tokens',
    );
    expect(tokens.map((t) => t.purpose)).toEqual(['RESET']);

    const audit = await query<{
      action: string;
      actor_type: string;
      details: Record<string, unknown>;
    }>(db, 'SELECT action, actor_type, details FROM audit_entries');
    expect(audit).toEqual([
      {
        action: 'ADMIN_CREATED',
        actor_type: 'SYSTEM',
        details: { source: 'bootstrap', name: ADMIN.name, email: ADMIN.email },
      },
    ]);

    expect(links()).toHaveLength(1);
    const link = String(links()[0]?.['link']);
    const match = /^http:\/\/localhost:8080\/reset-password\?token=([A-Za-z0-9_-]{43})$/.exec(link);
    expect(match, link).not.toBeNull();
    const hash = createHash('sha256')
      .update(match?.[1] ?? '')
      .digest();
    expect(tokens[0]?.token_hash.equals(hash)).toBe(true);
  });

  it('[FR-ADM-04] a second run creates and prints nothing; ten runs still give one admin and one link', async () => {
    const { db, options, links } = await setup();
    expect(await runBootstrap(options())).toBe('created');
    expect(await runBootstrap(options())).toBe('skipped');
    for (let i = 0; i < 8; i += 1) await runBootstrap(options());
    expect(await admins(db)).toHaveLength(1);
    expect(links()).toHaveLength(1);
    expect(await query(db, 'SELECT 1 FROM one_time_tokens')).toHaveLength(1);
    expect(await query(db, 'SELECT 1 FROM audit_entries')).toHaveLength(1);
  });

  it('[FR-ADM-04] two concurrent runs create one admin', async () => {
    const { db, options, links } = await setup();
    const results = await Promise.all([runBootstrap(options()), runBootstrap(options())]);
    expect(results.sort()).toEqual(['created', 'skipped']);
    expect(await admins(db)).toHaveLength(1);
    expect(links()).toHaveLength(1);
  });

  it('[FR-ADM-04] with no admin and the settings missing, it fails and creates nothing', async () => {
    const { db, options, links } = await setup();
    for (const missing of [{ email: undefined }, { name: undefined }]) {
      await expect(runBootstrap(options(missing))).rejects.toMatchObject({
        name: 'BootstrapError',
        code: 'BOOTSTRAP_SETTINGS_MISSING',
      });
    }
    expect(await query(db, 'SELECT 1 FROM users')).toHaveLength(0);
    expect(links()).toHaveLength(0);
  });

  it('[FR-ADM-04] with an admin present and the settings missing, it does nothing', async () => {
    const { db, options, links } = await setup();
    await runBootstrap(options());
    expect(await runBootstrap(options({ email: undefined, name: undefined }))).toBe('skipped');
    expect(await admins(db)).toHaveLength(1);
    expect(links()).toHaveLength(1);
  });

  it('[FR-ADM-04] an email that belongs to a non-admin fails, and nobody is promoted', async () => {
    const { db, options, links } = await setup();
    const owner = await db.client('po_owner');
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.actor_txid', txid_current()::text, true),
                              set_config('app.actor_type', 'SYSTEM', true)`);
    await owner.query(
      `INSERT INTO users (id, name, email, roles, status)
       VALUES (gen_random_uuid(), 'A Buyer', $1, '{BUYER}', 'ACTIVE')`,
      [ADMIN.email],
    );
    await owner.query('COMMIT');

    const failure = runBootstrap(options());
    await expect(failure).rejects.toBeInstanceOf(BootstrapError);
    await expect(failure).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });
    expect(await admins(db)).toEqual([]);
    expect(await query(db, `SELECT roles FROM users`)).toEqual([{ roles: ['BUYER'] }]);
    expect(await query(db, 'SELECT 1 FROM one_time_tokens')).toHaveLength(0);
    expect(links()).toHaveLength(0);
  });
});
