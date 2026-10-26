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

/** Runs statements in one transaction with the given transaction-local settings. */
async function inTx(
  client: pg.Client,
  settings: Record<string, string>,
  statements: (string | [string, unknown[]])[],
  end: 'COMMIT' | 'ROLLBACK' = 'COMMIT',
) {
  await client.query('BEGIN');
  try {
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
    // Back-date one entry as the superuser, standing in for nine years of waiting.
    const admin = await db.client('postgres');
    await admin.query(
      `UPDATE audit_entries SET occurred_at = now() - interval '9 years'
        WHERE id = (SELECT min(id) FROM audit_entries)`,
    );

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
