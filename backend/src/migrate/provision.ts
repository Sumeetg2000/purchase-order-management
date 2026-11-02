import { readFile } from 'node:fs/promises';
import pg from 'pg';

export interface RolePasswords {
  owner: string;
  app: string;
  maintenance: string;
}

const ROLES_SQL = new URL('../../db-init/roles.sql', import.meta.url);

/**
 * Step 1 of migrate (research R7): as the superuser, create or correct the three roles,
 * create the database owned by po_owner, and lock down database and schema privileges.
 * Safe to run on every start.
 */
export async function provisionDatabase(options: {
  superuserUrl: string;
  databaseName: string;
  passwords: RolePasswords;
}): Promise<void> {
  const { superuserUrl, databaseName, passwords } = options;
  const rolesSql = await readFile(ROLES_SQL, 'utf8');

  const admin = new pg.Client({ connectionString: withDatabase(superuserUrl, 'postgres') });
  await admin.connect();
  try {
    await admin.query(
      `SELECT set_config('po.owner_password', $1, false),
              set_config('po.app_password', $2, false),
              set_config('po.maintenance_password', $3, false)`,
      [passwords.owner, passwords.app, passwords.maintenance],
    );
    await admin.query(rolesSql);

    const db = admin.escapeIdentifier(databaseName);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${db} OWNER po_owner`);
    } else {
      await admin.query(`ALTER DATABASE ${db} OWNER TO po_owner`);
    }
    await grantDatabaseAccess(admin, databaseName);
  } finally {
    await admin.end();
  }

  const inDb = new pg.Client({ connectionString: withDatabase(superuserUrl, databaseName) });
  await inDb.connect();
  try {
    await inDb.query('ALTER SCHEMA public OWNER TO po_owner');
    await inDb.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  } finally {
    await inDb.end();
  }
}

/** Database-level ACLs are not copied by CREATE DATABASE … TEMPLATE, so tests reuse this. */
export async function grantDatabaseAccess(client: pg.Client, databaseName: string) {
  const db = client.escapeIdentifier(databaseName);
  await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${db} TO po_app, po_maintenance`);
}

export function withDatabase(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}
