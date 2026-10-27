import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_RETENTION_YEARS } from '../../src/audit/retention.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { PURGE_LOCK } from '../../src/db/locks.js';
import {
  auditEntriesTask,
  oneTimeTokensTask,
  runPurge,
  TOKEN_RETENTION_DAYS,
} from '../../src/maintenance/purge.js';
import { purgeTasks } from '../../src/maintenance/registry.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { createCapture } from '../support/log-capture.js';
import { trackDatabase } from '../support/setup.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const INSUFFICIENT_PRIVILEGE = '42501';
// A fixed point just behind the database clock: the audit retention guard compares with
// now(), so the purge's asOf must never be ahead of it.
const AS_OF = new Date(Date.now() - 60_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

function client(db: TestDatabase, role: 'po_app' | 'po_maintenance'): AppPrismaClient {
  const prisma = createPrismaClient({ url: db.url(role), poolSize: 2, connectionTimeoutMs: 2_000 });
  cleanups.push(() => prisma.$disconnect());
  return prisma;
}

/** Runs seeding SQL as the superuser with triggers off: audit entries are immutable. */
async function seed(db: TestDatabase, statements: string[]) {
  const admin = await db.client('postgres');
  await admin.query('BEGIN');
  await admin.query('SET LOCAL session_replication_role = replica');
  for (const statement of statements) await admin.query(statement);
  await admin.query('COMMIT');
}

const at = (date: Date) => `'${date.toISOString()}'::timestamptz`;
const yearsBefore = (years: number, date: Date) => {
  const copy = new Date(date);
  copy.setUTCFullYear(copy.getUTCFullYear() - years);
  return copy;
};

function auditEntry(occurredAt: Date, action: string) {
  return `INSERT INTO audit_entries (occurred_at, actor_type, action, entity_type, entity_id)
    VALUES (${at(occurredAt)}, 'SYSTEM', '${action}', 'user', '${randomUUID()}')`;
}

async function remaining(db: TestDatabase, sql: string): Promise<string[]> {
  const admin = await db.client('postgres');
  const { rows } = await admin.query<{ label: string }>(sql);
  return rows.map((row) => row.label).sort();
}

/** A token and its own user: a user may hold only one open token per purpose. */
function token(
  label: string,
  times: { createdAt: Date; expiresAt: Date; usedAt?: Date; supersededAt?: Date },
): string[] {
  const optional = (date?: Date) => (date ? at(date) : 'NULL');
  return [
    `INSERT INTO users (id, name, email, roles, status)
      VALUES ('${label}', 'Purge User', '${label}@example.local', '{}', 'ACTIVE')`,
    `INSERT INTO one_time_tokens
        (id, user_id, purpose, token_hash, created_at, expires_at, used_at, superseded_at)
      VALUES ('${label}', '${label}', 'RESET', '\\x${randomBytes(32).toString('hex')}',
        ${at(times.createdAt)}, ${at(times.expiresAt)}, ${optional(times.usedAt)},
        ${optional(times.supersededAt)})`,
  ];
}

const daysBefore = (days: number) => new Date(AS_OF.getTime() - days * DAY_MS);

async function holdLock(db: TestDatabase): Promise<pg.Client> {
  const holder = await db.client('po_maintenance');
  await holder.query('SELECT pg_advisory_lock($1)', [PURGE_LOCK.toString()]);
  return holder;
}

describe('[NFR-OPS-05] purge of audit entries and one-time tokens', () => {
  it('[NFR-OPS-05] registers the audit and token tasks for the maintenance loop', () => {
    expect(purgeTasks.map((task) => task.name)).toEqual(['audit_entries', 'one_time_tokens']);
  });

  it('[NFR-OPS-05] deletes audit entries older than 8 years and keeps newer ones', async () => {
    const db = trackDatabase(await createTestDatabase());
    const eightYears = yearsBefore(AUDIT_RETENTION_YEARS, AS_OF);
    await seed(db, [
      auditEntry(new Date(eightYears.getTime() - DAY_MS), 'OLD'),
      auditEntry(new Date(eightYears.getTime() + DAY_MS), 'YOUNG'),
      auditEntry(AS_OF, 'RECENT'),
    ]);
    const { logger } = createCapture();
    const outcome = await runPurge({
      tasks: [auditEntriesTask],
      db: client(db, 'po_maintenance'),
      lockUrl: db.url('po_maintenance'),
      logger,
      asOf: AS_OF,
    });
    expect(outcome).toEqual({ status: 'complete', counts: { audit_entries: 1 } });
    expect(await remaining(db, 'SELECT action AS label FROM audit_entries')).toEqual([
      'RECENT',
      'YOUNG',
    ]);
  });

  it('[NFR-OPS-05] deletes tokens whose COALESCE(used_at, superseded_at, expires_at) is more than 7 days old', async () => {
    expect(TOKEN_RETENTION_DAYS).toBe(7);
    const db = trackDatabase(await createTestDatabase());
    const ids = {
      expiredLongAgo: randomUUID(),
      usedLongAgo: randomUUID(),
      supersededLongAgo: randomUUID(),
      expiredRecently: randomUUID(),
      // Expired long ago but used recently: used_at comes first in the COALESCE.
      usedRecently: randomUUID(),
      open: randomUUID(),
    };
    await seed(db, [
      ...token(ids.expiredLongAgo, { createdAt: daysBefore(9), expiresAt: daysBefore(8) }),
      ...token(ids.usedLongAgo, {
        createdAt: daysBefore(9),
        expiresAt: daysBefore(-1),
        usedAt: daysBefore(8),
      }),
      ...token(ids.supersededLongAgo, {
        createdAt: daysBefore(9),
        expiresAt: daysBefore(-1),
        supersededAt: daysBefore(8),
      }),
      ...token(ids.expiredRecently, { createdAt: daysBefore(7), expiresAt: daysBefore(6) }),
      ...token(ids.usedRecently, {
        createdAt: daysBefore(11),
        expiresAt: daysBefore(10),
        usedAt: daysBefore(6),
      }),
      ...token(ids.open, { createdAt: daysBefore(0), expiresAt: daysBefore(-1) }),
    ]);
    const { logger } = createCapture();
    const outcome = await runPurge({
      tasks: [oneTimeTokensTask],
      db: client(db, 'po_maintenance'),
      lockUrl: db.url('po_maintenance'),
      logger,
      asOf: AS_OF,
    });
    expect(outcome).toEqual({ status: 'complete', counts: { one_time_tokens: 3 } });
    expect(await remaining(db, 'SELECT id::text AS label FROM one_time_tokens')).toEqual(
      [ids.expiredRecently, ids.usedRecently, ids.open].sort(),
    );
  });

  it('[NFR-OPS-05] deletes in batches, looping until nothing expired is left', async () => {
    const db = trackDatabase(await createTestDatabase());
    const old = new Date(yearsBefore(AUDIT_RETENTION_YEARS, AS_OF).getTime() - DAY_MS);
    await seed(
      db,
      Array.from({ length: 5 }, (_, i) => auditEntry(old, `OLD_${String(i)}`)),
    );
    const prisma = client(db, 'po_maintenance');
    const deletes = vi.spyOn(prisma, '$executeRaw');
    const { logger } = createCapture();
    const outcome = await runPurge({
      tasks: [auditEntriesTask],
      db: prisma,
      lockUrl: db.url('po_maintenance'),
      logger,
      asOf: AS_OF,
      batchSize: 2,
    });
    expect(outcome).toEqual({ status: 'complete', counts: { audit_entries: 5 } });
    // 2 + 2 + 1: the short batch ends the loop.
    expect(deletes).toHaveBeenCalledTimes(3);
  });

  it('[NFR-OPS-05] logs one line per table with its count', async () => {
    const db = trackDatabase(await createTestDatabase());
    const { logger, lines } = createCapture();
    await runPurge({
      tasks: purgeTasks,
      db: client(db, 'po_maintenance'),
      lockUrl: db.url('po_maintenance'),
      logger,
      asOf: AS_OF,
    });
    const perTable = lines.filter((line) => line['msg'] === 'purge table done');
    expect(perTable.map((line) => [line['table'], line['deleted']])).toEqual([
      ['audit_entries', 0],
      ['one_time_tokens', 0],
    ]);
    expect(lines.filter((line) => line['msg'] === 'purge run complete')).toHaveLength(1);
  });

  it('[NFR-OPS-05] a second run while the lock is held logs "already running" and deletes nothing', async () => {
    const db = trackDatabase(await createTestDatabase());
    const old = new Date(yearsBefore(AUDIT_RETENTION_YEARS, AS_OF).getTime() - DAY_MS);
    await seed(db, [auditEntry(old, 'OLD')]);
    await holdLock(db);
    const { logger, lines } = createCapture();
    const outcome = await runPurge({
      tasks: purgeTasks,
      db: client(db, 'po_maintenance'),
      lockUrl: db.url('po_maintenance'),
      logger,
      asOf: AS_OF,
    });
    expect(outcome).toEqual({ status: 'already_running' });
    expect(lines.map((line) => line['msg'])).toContain('purge already running');
    expect(await remaining(db, 'SELECT action AS label FROM audit_entries')).toEqual(['OLD']);
  });

  it('[NFR-OPS-05] a run killed mid-way releases the lock', async () => {
    const db = trackDatabase(await createTestDatabase());
    // A run holding the lock, then killed: its connection ends with the process.
    const killed = await holdLock(db);
    const { rows } = await killed.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    killed.on('error', () => undefined);
    const admin = await db.client('postgres');
    await admin.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
    const { logger } = createCapture();
    const outcome = await runPurge({
      tasks: purgeTasks,
      db: client(db, 'po_maintenance'),
      lockUrl: db.url('po_maintenance'),
      logger,
      asOf: AS_OF,
    });
    expect(outcome).toMatchObject({ status: 'complete' });
  });

  it('[NFR-OPS-05] the same deletes as po_app are refused', async () => {
    const db = trackDatabase(await createTestDatabase());
    const old = new Date(yearsBefore(AUDIT_RETENTION_YEARS, AS_OF).getTime() - DAY_MS);
    await seed(db, [auditEntry(old, 'OLD')]);
    const app = client(db, 'po_app');
    for (const task of purgeTasks) {
      // By SQLSTATE, not message text (ADR-0007): 42501 insufficient_privilege.
      await expect(task.run({ db: app, asOf: AS_OF, batchSize: 1_000 })).rejects.toMatchObject({
        meta: { driverAdapterError: { cause: { originalCode: INSUFFICIENT_PRIVILEGE } } },
      });
    }
    expect(await remaining(db, 'SELECT action AS label FROM audit_entries')).toEqual(['OLD']);
  });
});
