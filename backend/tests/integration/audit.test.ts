import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { writeAudit } from '../../src/audit/write.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction, type ActorContext } from '../../src/db/transaction.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { testLogger } from '../support/log-capture.js';
import { trackDatabase } from '../support/setup.js';

const ACTOR_CONTEXT_REQUIRED = 'PO001';
const ACTOR_CONTEXT_MISMATCH = 'PO002';
const AUDIT_IMMUTABLE = 'PO003';
const AUDIT_RETENTION_ACTIVE = 'PO004';
const INSUFFICIENT_PRIVILEGE = '42501';

const USER_ID = '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f';
const userActor: Record<string, string> = {
  'app.actor_type': 'USER',
  'app.actor_user_id': USER_ID,
  'app.actor_name': 'Asha Rao',
  'app.actor_email': 'asha@example.local',
  'app.acting_role': 'ADMIN',
  'app.request_id': 'req-audit-0001',
};

async function sqlstate(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/**
 * Runs statements in one transaction with the given transaction-local settings. Like
 * withTransaction, it binds the context to this transaction (app.actor_txid) unless the
 * settings give their own value.
 */
async function inTx(
  client: pg.Client,
  settings: Record<string, string>,
  statements: (string | [string, unknown[]])[],
  end: 'COMMIT' | 'ROLLBACK' = 'COMMIT',
) {
  await client.query('BEGIN');
  try {
    if (!('app.actor_txid' in settings)) {
      await client.query(`SELECT set_config('app.actor_txid', txid_current()::text, true)`);
    }
    for (const [name, value] of Object.entries(settings)) {
      await client.query('SELECT set_config($1, $2, true)', [name, value]);
    }
    for (const statement of statements) {
      if (typeof statement === 'string') await client.query(statement);
      else await client.query(statement[0], statement[1]);
    }
    await client.query(end);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const insertAudit = (extra = '', values = ''): string =>
  `INSERT INTO audit_entries (action, entity_type, entity_id, details${extra})
   VALUES ('ADMIN_CREATED', 'user', '${USER_ID}', '{}'${values})`;

const insertUser = (email = 'new@example.local'): [string, unknown[]] => [
  `INSERT INTO users (id, name, email, roles, status) VALUES (gen_random_uuid(), 'New User', $1, '{ADMIN}', 'ACTIVE')`,
  [email],
];

async function auditRows(db: TestDatabase) {
  const admin = await db.client('postgres');
  return (await admin.query<Record<string, unknown>>('SELECT * FROM audit_entries ORDER BY id'))
    .rows;
}

describe('[NFR-AUD-02] actor context is required for audited changes', () => {
  it('[NFR-AUD-02] an insert into users with no actor context is refused with ACTOR_CONTEXT_REQUIRED', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    expect(await sqlstate(() => inTx(app, {}, [insertUser()]))).toBe(ACTOR_CONTEXT_REQUIRED);
  });

  it('[NFR-AUD-02] an empty app.actor_type counts as no context', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    expect(await sqlstate(() => inTx(app, { 'app.actor_type': '' }, [insertUser()]))).toBe(
      ACTOR_CONTEXT_REQUIRED,
    );
    expect(await sqlstate(() => inTx(app, { 'app.actor_type': '' }, [insertAudit()]))).toBe(
      ACTOR_CONTEXT_REQUIRED,
    );
  });

  it('[NFR-AUD-02] an update of users without context is refused too', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(app, userActor, [insertUser()]);
    expect(await sqlstate(() => inTx(app, {}, [`UPDATE users SET name = 'Changed'`]))).toBe(
      ACTOR_CONTEXT_REQUIRED,
    );
  });

  it('[NFR-AUD-02] an audit entry without actor context is refused', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    expect(await sqlstate(() => inTx(app, {}, [insertAudit()]))).toBe(ACTOR_CONTEXT_REQUIRED);
  });

  it.each([
    ['USER without a user id', { ...userActor, 'app.actor_user_id': '' }],
    ['USER without an acting role', { ...userActor, 'app.acting_role': '' }],
    ['OPERATOR without an OS user', { 'app.actor_type': 'OPERATOR', 'app.os_host': 'ops-1' }],
    ['OPERATOR without a host', { 'app.actor_type': 'OPERATOR', 'app.os_user': 'deploy' }],
    ['SYSTEM with an actor id', { 'app.actor_type': 'SYSTEM', 'app.actor_user_id': USER_ID }],
    ['an unknown actor type', { 'app.actor_type': 'ROBOT' }],
    ['USER with a user id that is not a UUID', { ...userActor, 'app.actor_user_id': 'not-a-uuid' }],
  ])(
    '[NFR-AUD-02] an incomplete or inconsistent context is refused: %s',
    async (_case, settings) => {
      const db = trackDatabase(await createTestDatabase());
      const app = await db.client('po_app');
      expect(await sqlstate(() => inTx(app, settings, [insertAudit()]))).toBe(
        ACTOR_CONTEXT_REQUIRED,
      );
      expect(await sqlstate(() => inTx(app, settings, [insertUser()]))).toBe(
        ACTOR_CONTEXT_REQUIRED,
      );
    },
  );
});

describe('[NFR-AUD-02] the actor context belongs to one transaction', () => {
  const systemSession = [
    `SET app.actor_type = 'SYSTEM'`,
    `SET app.actor_user_id = ''`,
    `SET app.actor_name = ''`,
    `SET app.actor_email = ''`,
    `SET app.acting_role = ''`,
    `SET app.os_user = ''`,
    `SET app.os_host = ''`,
  ];

  it('[NFR-AUD-02] a session-level SET of the actor settings is refused in a later transaction', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    for (const statement of systemSession) await app.query(statement);
    // Even an actor_txid copied from an earlier transaction can't match a later one.
    const { rows } = await app.query<{ txid: string }>('SELECT txid_current()::text AS txid');
    await app.query(`SELECT set_config('app.actor_txid', $1, false)`, [rows[0]?.txid]);

    const later = async (sql: string | [string, unknown[]]) => {
      await app.query('BEGIN');
      try {
        if (typeof sql === 'string') await app.query(sql);
        else await app.query(sql[0], sql[1]);
        await app.query('COMMIT');
      } catch (error) {
        await app.query('ROLLBACK');
        throw error;
      }
    };
    expect(await sqlstate(() => later(insertAudit()))).toBe(ACTOR_CONTEXT_REQUIRED);
    expect(await sqlstate(() => later(insertUser()))).toBe(ACTOR_CONTEXT_REQUIRED);
    expect(await sqlstate(() => app.query(insertAudit()))).toBe(ACTOR_CONTEXT_REQUIRED);
    expect(await auditRows(db)).toHaveLength(0);
  });

  it('[NFR-AUD-02] a transaction-local context without app.actor_txid is refused', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    const unbound = { ...userActor, 'app.actor_txid': '' };
    expect(await sqlstate(() => inTx(app, unbound, [insertAudit()]))).toBe(ACTOR_CONTEXT_REQUIRED);
    expect(await sqlstate(() => inTx(app, unbound, [insertUser()]))).toBe(ACTOR_CONTEXT_REQUIRED);
  });

  it('[NFR-AUD-02] withTransaction binds the context to its own transaction', async () => {
    const db = trackDatabase(await createTestDatabase());
    const prisma: AppPrismaClient = createPrismaClient({
      url: db.url('po_app'),
      poolSize: 1,
      connectionTimeoutMs: 2_000,
    });
    try {
      const bound = await withTransaction(
        {
          prisma,
          actor: { type: 'SYSTEM' },
          requestId: 'req-txid-0001',
          timeoutMs: 5_000,
          maxWaitMs: 2_000,
          logger: testLogger(),
        },
        (tx) =>
          tx.$queryRaw<{ bound: boolean }[]>`
            SELECT current_setting('app.actor_txid', true) = txid_current()::text AS bound`,
      );
      expect(bound[0]?.bound).toBe(true);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe('[NFR-AUD-02] users timestamps', () => {
  it('[NFR-AUD-02] an update sets updated_at from the database clock, whatever the statement says', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(app, userActor, [insertUser('stamp@example.local')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await inTx(app, userActor, [
      `UPDATE users SET name = 'Renamed', updated_at = '2001-01-01T00:00:00Z' WHERE email = 'stamp@example.local'`,
    ]);
    const admin = await db.client('postgres');
    const { rows } = await admin.query<{ created_at: Date; updated_at: Date }>(
      `SELECT created_at, updated_at FROM users WHERE email = 'stamp@example.local'`,
    );
    const [row] = rows;
    expect(row && row.updated_at.getTime()).toBeGreaterThan(row?.created_at.getTime() ?? Infinity);
  });
});

describe('[NFR-AUD-02] audit entries take their actor from the context', () => {
  it('[NFR-AUD-02] fills the actor fields and request id from the context, and the time from the database clock', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(app, userActor, [insertAudit(', occurred_at', `, '2001-01-01T00:00:00Z'`)]);
    const [row] = await auditRows(db);
    expect(row).toMatchObject({
      actor_type: 'USER',
      actor_user_id: USER_ID,
      actor_name: 'Asha Rao',
      actor_email: 'asha@example.local',
      acting_role: 'ADMIN',
      request_id: 'req-audit-0001',
    });
    expect((row?.['occurred_at'] as Date).getUTCFullYear()).toBeGreaterThan(2001);
  });

  it('[NFR-AUD-02] an OPERATOR entry records osUser and host in details', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(
      app,
      {
        'app.actor_type': 'OPERATOR',
        'app.os_user': 'deploy',
        'app.os_host': 'ops-1',
        'app.request_id': 'cli-0001',
      },
      [insertAudit()],
    );
    const [row] = await auditRows(db);
    expect(row).toMatchObject({
      actor_type: 'OPERATOR',
      actor_user_id: null,
      request_id: 'cli-0001',
    });
    expect(row?.['details']).toMatchObject({ osUser: 'deploy', host: 'ops-1' });
  });

  it.each([
    ['actor_type', `'SYSTEM'`],
    ['actor_user_id', `'0192e4a0-0000-7000-8000-000000000000'`],
    ['actor_email', `'someone-else@example.local'`],
    ['request_id', `'req-forged-0001'`],
  ])(
    '[NFR-AUD-02] an explicit %s that contradicts the context is ACTOR_CONTEXT_MISMATCH',
    async (column, value) => {
      const db = trackDatabase(await createTestDatabase());
      const app = await db.client('po_app');
      expect(
        await sqlstate(() => inTx(app, userActor, [insertAudit(`, ${column}`, `, ${value}`)])),
      ).toBe(ACTOR_CONTEXT_MISMATCH);
    },
  );

  it('[NFR-AUD-02] an explicit actor_user_id equal to the context, in another letter case, is accepted', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    const upperCaseContext = { ...userActor, 'app.actor_user_id': USER_ID.toUpperCase() };
    await inTx(app, upperCaseContext, [insertAudit(', actor_user_id', `, '${USER_ID}'`)]);
    const [row] = await auditRows(db);
    expect(row?.['actor_user_id']).toBe(USER_ID);
  });

  it('[NFR-AUD-02] an operator osUser in details that contradicts the context is ACTOR_CONTEXT_MISMATCH', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    const operator = {
      'app.actor_type': 'OPERATOR',
      'app.os_user': 'deploy',
      'app.os_host': 'ops-1',
    };
    const forged = `INSERT INTO audit_entries (action, entity_type, entity_id, details)
                    VALUES ('ADMIN_CREATED', 'user', '${USER_ID}', '{"osUser": "root"}')`;
    expect(await sqlstate(() => inTx(app, operator, [forged]))).toBe(ACTOR_CONTEXT_MISMATCH);
  });

  it.each([
    ['USER', userActor],
    ['SYSTEM', { 'app.actor_type': 'SYSTEM' }],
  ])(
    '[NFR-AUD-02] a %s entry may not carry operator keys in details, even as null',
    async (_type, ctx) => {
      const db = trackDatabase(await createTestDatabase());
      const app = await db.client('po_app');
      const forged = `INSERT INTO audit_entries (action, entity_type, entity_id, details)
                    VALUES ('ADMIN_CREATED', 'user', '${USER_ID}', '{"osUser": null, "host": null}')`;
      expect(await sqlstate(() => inTx(app, ctx, [forged]))).toBe(ACTOR_CONTEXT_MISMATCH);
    },
  );

  it.each(['po_app', 'po_maintenance'] as const)(
    '[NFR-AUD-02] %s cannot choose an audit entry id (OVERRIDING SYSTEM VALUE)',
    async (role) => {
      const db = trackDatabase(await createTestDatabase());
      const client = await db.client(role);
      const forged = `INSERT INTO audit_entries (id, action, entity_type, entity_id, details)
                      OVERRIDING SYSTEM VALUE VALUES (1, 'ADMIN_CREATED', 'user', '${USER_ID}', '{}')`;
      expect(await sqlstate(() => inTx(client, { 'app.actor_type': 'SYSTEM' }, [forged]))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    },
  );

  it('[NFR-AUD-02] a rolled-back transaction leaves no entry', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(app, userActor, [insertUser(), insertAudit()], 'ROLLBACK');
    expect(await auditRows(db)).toEqual([]);
  });

  it('[NFR-AUD-02] withTransaction sets the context, so the real write path succeeds', async () => {
    const db = trackDatabase(await createTestDatabase());
    const prisma: AppPrismaClient = createPrismaClient({
      url: db.url('po_app'),
      poolSize: 2,
      connectionTimeoutMs: 2_000,
    });
    try {
      const actor: ActorContext = { type: 'SYSTEM' };
      await withTransaction(
        {
          prisma,
          actor,
          requestId: 'req-real-0001',
          timeoutMs: 5_000,
          maxWaitMs: 2_000,
          logger: testLogger(),
        },
        async (tx) => {
          await tx.$executeRawUnsafe(insertUser()[0], 'real@example.local');
          await tx.$executeRawUnsafe(insertAudit());
        },
      );
    } finally {
      await prisma.$disconnect();
    }
    const [row] = await auditRows(db);
    expect(row).toMatchObject({
      actor_type: 'SYSTEM',
      actor_user_id: null,
      request_id: 'req-real-0001',
    });
  });
});

describe('[NFR-AUD-02] the actor CHECK holds even without the triggers', () => {
  // As the superuser with triggers off, standing in for a backfill or a replaced trigger.
  async function insertRaw(db: TestDatabase, columns: string, values: string) {
    const admin = await db.client('postgres');
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL session_replication_role = replica');
      await admin.query(
        `INSERT INTO audit_entries (action, entity_type, entity_id, ${columns})
         VALUES ('ADMIN_CREATED', 'user', '${USER_ID}', ${values})`,
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }

  it.each([
    ['actor_name', `'Asha Rao'`],
    ['actor_email', `'asha@example.local'`],
    ['acting_role', `'ADMIN'`],
  ])('[NFR-AUD-02] an OPERATOR entry carrying %s is refused', async (column, value) => {
    const db = trackDatabase(await createTestDatabase());
    expect(
      await sqlstate(() =>
        insertRaw(
          db,
          `actor_type, details, ${column}`,
          `'OPERATOR', '{"osUser": "deploy", "host": "ops-1"}', ${value}`,
        ),
      ),
    ).toBe('23514');
  });

  it('[NFR-AUD-02] a well-formed OPERATOR entry passes the CHECK', async () => {
    const db = trackDatabase(await createTestDatabase());
    await insertRaw(
      db,
      'actor_type, details',
      `'OPERATOR', '{"osUser": "deploy", "host": "ops-1"}'`,
    );
    expect(await auditRows(db)).toHaveLength(1);
  });
});

describe('[NFR-AUD-02] typed audit writer', () => {
  it('[NFR-AUD-02] writeAudit records a typed event inside withTransaction, the actor coming from the context', async () => {
    const db = trackDatabase(await createTestDatabase());
    const prisma = createPrismaClient({
      url: db.url('po_app'),
      poolSize: 2,
      connectionTimeoutMs: 2_000,
    });
    try {
      await withTransaction(
        {
          prisma,
          actor: { type: 'OPERATOR', osUser: 'deploy', host: 'ops-1' },
          requestId: 'cli-run-0001',
          timeoutMs: 5_000,
          maxWaitMs: 2_000,
          logger: testLogger(),
        },
        (tx) =>
          writeAudit(tx, {
            action: 'ADMIN_CREATED',
            entityType: 'user',
            entityId: USER_ID,
            details: { source: 'cli', name: 'Asha Rao', email: 'asha@example.local' },
          }),
      );
    } finally {
      await prisma.$disconnect();
    }
    const [row] = await auditRows(db);
    expect(row).toMatchObject({
      action: 'ADMIN_CREATED',
      entity_type: 'user',
      entity_id: USER_ID,
      actor_type: 'OPERATOR',
      request_id: 'cli-run-0001',
    });
    expect(row?.['details']).toEqual({
      source: 'cli',
      name: 'Asha Rao',
      email: 'asha@example.local',
      osUser: 'deploy',
      host: 'ops-1',
    });
  });
});

describe('[NFR-AUD-02] audit entries are append-only within retention', () => {
  it('[NFR-AUD-02] po_app can insert audit entries but never update or delete them', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(app, userActor, [insertAudit()]);
    expect(
      await sqlstate(() => inTx(app, userActor, [`UPDATE audit_entries SET action = 'X'`])),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(() => inTx(app, userActor, ['DELETE FROM audit_entries']))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await auditRows(db)).toHaveLength(1);
  });

  it('[NFR-AUD-02] po_maintenance can delete only entries past the 8-year retention', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(app, userActor, [insertAudit(), insertAudit()]);
    // Back-date one entry as the superuser with triggers off (entries are immutable),
    // standing in for nine years of waiting.
    const admin = await db.client('postgres');
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `UPDATE audit_entries SET occurred_at = now() - interval '9 years'
        WHERE id = (SELECT min(id) FROM audit_entries)`,
    );
    await admin.query('COMMIT');

    const maintenance = await db.client('po_maintenance');
    expect(await sqlstate(() => maintenance.query(`DELETE FROM audit_entries`))).toBe(
      AUDIT_RETENTION_ACTIVE,
    );
    expect(await auditRows(db)).toHaveLength(2);

    const purged = await maintenance.query(
      `DELETE FROM audit_entries WHERE occurred_at < now() - interval '8 years'`,
    );
    expect(purged.rowCount).toBe(1);
    expect(await auditRows(db)).toHaveLength(1);
  });

  it('[NFR-AUD-02] TRUNCATE of audit entries is refused for the owner too', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(app, userActor, [insertAudit()]);
    const owner = await db.client('po_owner');
    expect(await sqlstate(() => owner.query('TRUNCATE audit_entries'))).toBe(
      AUDIT_RETENTION_ACTIVE,
    );
    expect(await auditRows(db)).toHaveLength(1);
  });

  it('[NFR-AUD-02] audit entries are immutable, for the owner too', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(app, userActor, [insertAudit()]);
    const owner = await db.client('po_owner');
    expect(
      await sqlstate(() =>
        owner.query(
          `UPDATE audit_entries SET action = 'REWRITTEN', occurred_at = '2001-01-01T00:00:00Z'`,
        ),
      ),
    ).toBe(AUDIT_IMMUTABLE);
    expect(
      await sqlstate(() => inTx(owner, userActor, [`UPDATE audit_entries SET details = '{}'`])),
    ).toBe(AUDIT_IMMUTABLE);

    // So a back-dated entry can't be slipped past the retention purge.
    const maintenance = await db.client('po_maintenance');
    const purged = await maintenance.query(
      `DELETE FROM audit_entries WHERE occurred_at < now() - interval '8 years'`,
    );
    expect(purged.rowCount).toBe(0);
    expect(await auditRows(db)).toEqual([expect.objectContaining({ action: 'ADMIN_CREATED' })]);
  });

  it('[NFR-AUD-02] the retention guard applies to the owner too', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await inTx(app, userActor, [insertAudit()]);
    const owner = await db.client('po_owner');
    expect(await sqlstate(() => owner.query('DELETE FROM audit_entries'))).toBe(
      AUDIT_RETENTION_ACTIVE,
    );
  });
});
