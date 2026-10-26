import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { grantDatabaseAccess } from '../../src/migrate/provision.js';
import { TEMPLATE_DATABASE, roleUrl, type PostgresConnection } from './postgres.js';

export interface TestDatabase {
  name: string;
  connection: PostgresConnection;
  /** Connection URL for one of the roles, on this test's database. */
  url: (role: 'postgres' | 'po_owner' | 'po_app' | 'po_maintenance') => string;
  /** A connected pg client for one of the roles. Closed by drop(). */
  client: (role: 'postgres' | 'po_owner' | 'po_app' | 'po_maintenance') => Promise<pg.Client>;
  drop: () => Promise<void>;
}

/**
 * A fresh database for one test, cloned from the migrated template in milliseconds.
 * Commits, roles and triggers behave exactly as in production (research R19).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const connection = inject('postgres');
  const name = `test_${randomUUID().replaceAll('-', '')}`;

  const admin = new pg.Client({ connectionString: roleUrl(connection, 'postgres', 'postgres') });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${TEMPLATE_DATABASE} OWNER po_owner`,
    );
    await grantDatabaseAccess(admin, name);
  } finally {
    await admin.end();
  }

  const opened: pg.Client[] = [];
  const url: TestDatabase['url'] = (role) => roleUrl(connection, role, name);

  return {
    name,
    connection,
    url,
    client: async (role) => {
      const client = new pg.Client({ connectionString: url(role) });
      await client.connect();
      opened.push(client);
      return client;
    },
    drop: async () => {
      await Promise.all(opened.map((c) => c.end().catch(() => undefined)));
      const dropper = new pg.Client({
        connectionString: roleUrl(connection, 'postgres', 'postgres'),
      });
      await dropper.connect();
      try {
        await dropper.query(
          `DROP DATABASE IF EXISTS ${dropper.escapeIdentifier(name)} WITH (FORCE)`,
        );
      } finally {
        await dropper.end();
      }
    },
  };
}
