import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { listMigrations } from '../../src/http/routes/health.js';
import { deployMigrations } from '../../src/migrate/deploy.js';
import { provisionDatabase } from '../../src/migrate/provision.js';
import { createTestDatabase } from '../support/db.js';
import { TEST_PASSWORDS, roleUrl } from '../support/postgres.js';
import { trackDatabase } from '../support/setup.js';

const run = promisify(execFile);
const BACKEND_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RECONCILIATION_SQL = new URL('../../src/db/reconciliation.sql', import.meta.url);

// One empty database, provisioned and migrated exactly as the migrate step does it, not
// cloned from the template.
const name = `empty_${randomUUID().replaceAll('-', '')}`;
const dropAfter: string[] = [];

afterAll(async () => {
  const connection = inject('postgres');
  const admin = new pg.Client({ connectionString: roleUrl(connection, 'postgres', 'postgres') });
  await admin.connect();
  try {
    for (const db of dropAfter) {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(db)} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
});

async function migrateEmptyDatabase(): Promise<string> {
  const connection = inject('postgres');
  dropAfter.push(name);
  await provisionDatabase({
    superuserUrl: roleUrl(connection, 'postgres', 'postgres'),
    databaseName: name,
    passwords: {
      owner: TEST_PASSWORDS.owner,
      app: TEST_PASSWORDS.app,
      maintenance: TEST_PASSWORDS.maintenance,
    },
  });
  const ownerUrl = roleUrl(connection, 'po_owner', name);
  await deployMigrations(ownerUrl);
  return ownerUrl;
}

describe('[NFR-DEV-01] migrations from empty', () => {
  let ownerUrl = '';

  beforeAll(async () => {
    ownerUrl = await migrateEmptyDatabase();
  });

  it('[NFR-DEV-01] every migration applies to an empty database, in order', async () => {
    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ migration_name: string }>(
        `SELECT migration_name FROM _prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
          ORDER BY started_at, migration_name`,
      );
      expect(rows.map((r) => r.migration_name)).toEqual(await listMigrations());
    } finally {
      await client.end();
    }
  });

  it('[NFR-DEV-01] schema.prisma matches the migrated database (prisma migrate diff is empty)', async () => {
    const result = await run(
      'npx',
      [
        '--no-install',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      { cwd: BACKEND_ROOT, env: { ...process.env, OWNER_DATABASE_URL: ownerUrl } },
    ).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (error: unknown) => {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code, stdout: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
      },
    );
    expect(result, result.stdout).toMatchObject({ code: 0 });
  });
});

describe('[NFR-DEV-01] reconciliation', () => {
  it('[NFR-DEV-01] the reconciliation query returns no rows on a migrated database, run as po_app', async () => {
    const sql = await readFile(RECONCILIATION_SQL, 'utf8');
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    const { rows } = await app.query(sql);
    expect(rows).toEqual([]);
  });
});
