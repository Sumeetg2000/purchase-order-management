import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

// The exact privilege set the migrations must produce (data-model.md, ADR-0003). Any
// extra grant, PUBLIC grant, default privilege or ownership fails this test.

const ROLES = ['po_owner', 'po_app', 'po_maintenance'] as const;

/** Every grant on tables, views and sequences in public, excluding the owner's own. */
const EXPECTED_RELATION_GRANTS = [
  '_prisma_migrations po_app SELECT',
  'audit_entries po_app SELECT',
  'audit_entries po_maintenance DELETE',
  'audit_entries po_maintenance SELECT',
  'users po_app INSERT',
  'users po_app SELECT',
  'users po_app UPDATE',
];

// INSERT on audit_entries is granted per column, never on id, so no writer can choose an
// entry's id (OVERRIDING SYSTEM VALUE).
const AUDIT_INSERT_COLUMNS = [
  'acting_role',
  'action',
  'actor_email',
  'actor_name',
  'actor_type',
  'actor_user_id',
  'details',
  'entity_id',
  'entity_type',
  'occurred_at',
  'order_id',
  'po_number',
  'request_id',
];

async function rows<T extends pg.QueryResultRow>(client: pg.Client, sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows;
}

async function sqlstate(client: pg.Client, sql: string): Promise<string | undefined> {
  try {
    await client.query(sql);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function freshDb(): Promise<{ db: TestDatabase; admin: pg.Client }> {
  const db = trackDatabase(await createTestDatabase());
  return { db, admin: await db.client('postgres') };
}

describe('[NFR-AUD-02] roles and privileges snapshot', () => {
  it('[NFR-AUD-02] every role is NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION', async () => {
    const { admin } = await freshDb();
    const found = await rows<{ rolname: string; powerful: boolean }>(
      admin,
      `SELECT rolname, (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication) AS powerful
         FROM pg_roles WHERE rolname IN ('po_owner', 'po_app', 'po_maintenance') ORDER BY rolname`,
    );
    expect(found).toEqual([...ROLES].sort().map((rolname) => ({ rolname, powerful: false })));
  });

  it('[NFR-AUD-02] po_owner owns every object in public; po_app and po_maintenance own nothing', async () => {
    const { admin } = await freshDb();
    const owned = await rows<{ kind: string; name: string; owner: string }>(
      admin,
      `SELECT 'relation' AS kind, c.relname AS name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
       UNION ALL
       SELECT 'function', p.proname, pg_get_userbyid(p.proowner)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
       UNION ALL
       SELECT 'type', t.typname, pg_get_userbyid(t.typowner)
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'
       UNION ALL
       SELECT 'schema', n.nspname, pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE n.nspname = 'public'
       UNION ALL
       SELECT 'database', d.datname, pg_get_userbyid(d.datdba) FROM pg_database d WHERE d.datname = current_database()`,
    );
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.filter((o) => o.owner !== 'po_owner')).toEqual([]);

    const elsewhere = await rows<{ count: string }>(
      admin,
      `SELECT count(*)::text AS count FROM pg_class
        WHERE relowner IN (SELECT oid FROM pg_roles WHERE rolname IN ('po_app', 'po_maintenance'))`,
    );
    expect(elsewhere[0]?.count).toBe('0');
  });

  it('[NFR-AUD-02] table and sequence grants are exactly the expected list; PUBLIC has none', async () => {
    const { admin } = await freshDb();
    const grants = await rows<{ grant: string }>(
      admin,
      `SELECT c.relname || ' ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                || ' ' || a.privilege_type AS grant
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND a.grantee <> c.relowner
        ORDER BY 1`,
    );
    expect(grants.map((g) => g.grant)).toEqual(EXPECTED_RELATION_GRANTS);
  });

  it('[NFR-AUD-02] column grants are exactly INSERT on the audit columns other than id', async () => {
    const { admin } = await freshDb();
    const columns = await rows<{ grant: string }>(
      admin,
      `SELECT c.relname || '.' || a.attname || ' '
                || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
                || ' ' || x.privilege_type AS grant
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(a.attacl) x
        WHERE n.nspname = 'public' AND a.attacl IS NOT NULL
        ORDER BY 1`,
    );
    const expected = ['po_app', 'po_maintenance']
      .flatMap((role) => AUDIT_INSERT_COLUMNS.map((col) => `audit_entries.${col} ${role} INSERT`))
      .sort();
    expect(columns.map((c) => c.grant)).toEqual(expected);
  });

  it('[NFR-AUD-02] functions grant EXECUTE to nobody but their owner (not PUBLIC)', async () => {
    const { admin } = await freshDb();
    const grants = await rows<{ grant: string }>(
      admin,
      `SELECT p.proname || ' ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grant
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE n.nspname = 'public' AND a.grantee <> p.proowner`,
    );
    expect(grants).toEqual([]);
  });

  it('[NFR-AUD-02] the schema and database grant only USAGE and CONNECT to the two roles', async () => {
    const { admin } = await freshDb();
    const schema = await rows<{ grant: string }>(
      admin,
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type AS grant
         FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
        WHERE n.nspname = 'public' AND a.grantee <> n.nspowner ORDER BY 1`,
    );
    expect(schema.map((g) => g.grant)).toEqual(['po_app USAGE', 'po_maintenance USAGE']);

    const database = await rows<{ grant: string }>(
      admin,
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type AS grant
         FROM pg_database d
         CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
        WHERE d.datname = current_database() AND a.grantee <> d.datdba ORDER BY 1`,
    );
    expect(database.map((g) => g.grant)).toEqual(['po_app CONNECT', 'po_maintenance CONNECT']);
  });

  it('[NFR-AUD-02] no default privileges are configured', async () => {
    const { admin } = await freshDb();
    const defaults = await rows<{ role: string; objtype: string }>(
      admin,
      `SELECT pg_get_userbyid(defaclrole) AS role, defaclobjtype AS objtype FROM pg_default_acl`,
    );
    expect(defaults).toEqual([]);
  });

  it('[NFR-AUD-02] trigger functions are SECURITY INVOKER with a fixed search_path', async () => {
    const { admin } = await freshDb();
    const functions = await rows<{ proname: string; prosecdef: boolean; config: string[] | null }>(
      admin,
      `SELECT p.proname, p.prosecdef, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' ORDER BY p.proname`,
    );
    expect(functions.map((f) => f.proname)).toEqual(
      expect.arrayContaining([
        'audit_fill_actor',
        'audit_retention_guard',
        'require_actor_context',
      ]),
    );
    for (const fn of functions) {
      expect(fn.prosecdef, fn.proname).toBe(false);
      expect(fn.config ?? [], fn.proname).toContain('search_path=pg_catalog, pg_temp');
    }
  });

  it('[NFR-AUD-02] the audit triggers exist and are enabled', async () => {
    const { admin } = await freshDb();
    const triggers = await rows<{ trigger: string }>(
      admin,
      `SELECT c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text AS trigger
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal ORDER BY 1`,
    );
    expect(triggers.map((t) => t.trigger)).toEqual([
      'audit_entries audit_fill_actor O',
      'audit_entries audit_no_truncate O',
      'audit_entries audit_retention_guard O',
      'audit_entries require_actor_context O',
      'users require_actor_context O',
    ]);
  });
});

describe('[NFR-AUD-02] the application and maintenance roles cannot bypass the database rules', () => {
  const INSUFFICIENT_PRIVILEGE = '42501';

  for (const role of ['po_app', 'po_maintenance'] as const) {
    it(`[NFR-AUD-02] ${role} cannot alter, disable or drop the triggers or their functions`, async () => {
      const { db } = await freshDb();
      const client = await db.client(role);
      for (const sql of [
        'ALTER TABLE audit_entries DISABLE TRIGGER audit_fill_actor',
        'ALTER TABLE audit_entries DISABLE TRIGGER ALL',
        'ALTER TABLE users DISABLE TRIGGER require_actor_context',
        'DROP TRIGGER audit_retention_guard ON audit_entries',
        'ALTER TABLE audit_entries ADD COLUMN sneaky int',
        'ALTER FUNCTION require_actor_context() SECURITY DEFINER',
        `CREATE OR REPLACE FUNCTION audit_fill_actor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        'DROP FUNCTION audit_retention_guard()',
      ]) {
        expect(await sqlstate(client, sql), `${role}: ${sql}`).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });

    it(`[NFR-AUD-02] ${role} cannot switch triggers off with session_replication_role`, async () => {
      const { db } = await freshDb();
      const client = await db.client(role);
      expect(await sqlstate(client, 'SET session_replication_role = replica')).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it(`[NFR-AUD-02] ${role} cannot UPDATE or TRUNCATE audit entries`, async () => {
      const { db } = await freshDb();
      const client = await db.client(role);
      expect(await sqlstate(client, `UPDATE audit_entries SET action = 'X'`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlstate(client, 'TRUNCATE audit_entries')).toBe(INSUFFICIENT_PRIVILEGE);
    });
  }

  it('[NFR-AUD-02] po_app cannot DELETE audit entries or users, or TRUNCATE users', async () => {
    const { db } = await freshDb();
    const app = await db.client('po_app');
    expect(await sqlstate(app, 'DELETE FROM audit_entries')).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(app, 'DELETE FROM users')).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(app, 'TRUNCATE users')).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('[NFR-AUD-02] po_maintenance cannot read or change users', async () => {
    const { db } = await freshDb();
    const maintenance = await db.client('po_maintenance');
    expect(await sqlstate(maintenance, 'SELECT 1 FROM users')).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(maintenance, `UPDATE users SET name = 'x'`)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
