import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

const APP_ORIGIN = 'http://localhost:8080';
const OPERATOR = { osUser: 'deploy', host: 'ops-host-1' };

function envFor(databaseUrl: string): Record<string, string> {
  return { APP_ENV: 'local', APP_ORIGIN, DATABASE_URL: databaseUrl, LOG_LEVEL: 'error' };
}

async function cli(argv: string[], env: Record<string, string>) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...OPERATOR,
  });
  return { code, stdout, stderr };
}

async function query<T extends Record<string, unknown>>(db: TestDatabase, sql: string) {
  const admin = await db.client('postgres');
  return (await admin.query<T>(sql)).rows;
}

const create = ['admin:create', '--email', 'Second@Example.local', '--name', 'Second Admin'];

describe('[FR-ADM-05] admin:create', () => {
  it('[FR-ADM-05] creates an active admin, a RESET token and an OPERATOR audit entry, and prints the link block', async () => {
    const db = trackDatabase(await createTestDatabase());
    const result = await cli(create, envFor(db.url('po_app')));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const lines = result.stdout.split('\n');
    expect(lines.slice(0, 2)).toEqual([
      'Admin created: second@example.local',
      'One-time set-password link (valid 30 minutes, shown once):',
    ]);
    const match = /^http:\/\/localhost:8080\/reset-password#token=([A-Za-z0-9_-]{43})$/.exec(
      lines[2] ?? '',
    );
    expect(match, lines[2]).not.toBeNull();

    expect(await query(db, `SELECT email, roles, status, password_hash FROM users`)).toEqual([
      { email: 'second@example.local', roles: ['ADMIN'], status: 'ACTIVE', password_hash: null },
    ]);
    const [token] = await query<{ purpose: string; token_hash: Buffer }>(
      db,
      'SELECT purpose, token_hash FROM one_time_tokens',
    );
    expect(token?.purpose).toBe('RESET');
    expect(
      token?.token_hash.equals(
        createHash('sha256')
          .update(match?.[1] ?? '')
          .digest(),
      ),
    ).toBe(true);
    expect(await query(db, 'SELECT action, actor_type, details FROM audit_entries')).toEqual([
      {
        action: 'ADMIN_CREATED',
        actor_type: 'OPERATOR',
        details: {
          source: 'cli',
          name: 'Second Admin',
          email: 'second@example.local',
          osUser: OPERATOR.osUser,
          host: OPERATOR.host,
        },
      },
    ]);
  });

  it('[FR-ADM-05] an email already in use is EMAIL_IN_USE, exit 2, and nothing changes', async () => {
    const db = trackDatabase(await createTestDatabase());
    const env = envFor(db.url('po_app'));
    expect((await cli(create, env)).code).toBe(0);
    const again = await cli(
      ['admin:create', '--email', 'second@example.local', '--name', 'Someone Else'],
      env,
    );
    expect(again.code).toBe(2);
    expect(again.stdout).toBe('');
    expect(again.stderr).toMatch(/^ERROR EMAIL_IN_USE: /);
    expect(await query(db, 'SELECT name FROM users')).toEqual([{ name: 'Second Admin' }]);
    expect(await query(db, 'SELECT 1 FROM one_time_tokens')).toHaveLength(1);
    expect(await query(db, 'SELECT 1 FROM audit_entries')).toHaveLength(1);
  });

  it('[FR-ADM-05] an email taken concurrently by a writer outside the admin lock is still EMAIL_IN_USE, exit 2', async () => {
    const db = trackDatabase(await createTestDatabase());
    // A signup-like insert that doesn't take ADMIN_LOCK, uncommitted while the CLI runs:
    // the CLI's lookup can't see it, and its insert waits on the unique index.
    const writer = await db.client('po_owner');
    await writer.query('BEGIN');
    await writer.query(`SELECT set_config('app.actor_txid', txid_current()::text, true),
                               set_config('app.actor_type', 'SYSTEM', true)`);
    await writer.query(
      `INSERT INTO users (id, name, email, roles, status)
       VALUES (gen_random_uuid(), 'Signed Up', 'second@example.local', '{}', 'ACTIVE')`,
    );
    const pending = cli(create, envFor(db.url('po_app')));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writer.query('COMMIT');

    const result = await pending;
    expect(result.stderr).toMatch(/^ERROR EMAIL_IN_USE: /);
    expect(result.code).toBe(2);
    expect(await query(db, 'SELECT name, roles FROM users')).toEqual([
      { name: 'Signed Up', roles: [] },
    ]);
    expect(await query(db, 'SELECT 1 FROM one_time_tokens')).toHaveLength(0);
  });

  it.each([
    ['no command', [], 'USAGE'],
    ['an unknown command', ['admin:explode'], 'USAGE'],
    ['a missing --name', ['admin:create', '--email', 'x@example.local'], 'USAGE'],
    ['a missing --email', ['admin:create', '--name', 'X'], 'USAGE'],
    ['an unknown flag', [...create, '--role', 'ADMIN'], 'USAGE'],
    [
      'an invalid email',
      ['admin:create', '--email', 'not-an-email', '--name', 'X'],
      'INVALID_ARGUMENT',
    ],
    [
      'an empty name',
      ['admin:create', '--email', 'x@example.local', '--name', '  '],
      'INVALID_ARGUMENT',
    ],
    [
      'a name over 100 characters',
      ['admin:create', '--email', 'x@example.local', '--name', 'n'.repeat(101)],
      'INVALID_ARGUMENT',
    ],
  ])('[FR-ADM-05] %s is exit 1 with ERROR %s, and nothing changes', async (_case, argv, code) => {
    const db = trackDatabase(await createTestDatabase());
    const result = await cli(argv, envFor(db.url('po_app')));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`^ERROR ${code}: `));
    expect(await query(db, 'SELECT 1 FROM users')).toHaveLength(0);
  });

  it('[FR-ADM-05] a usage error never echoes what was typed', async () => {
    const result = await cli(['--email', 'ceo@corp.example', 'admin:create'], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^ERROR USAGE: /);
    expect(result.stderr).not.toContain('ceo@corp.example');
    expect(result.stderr).not.toContain('--email');
  });

  it.each([[['--help']], [['admin:create', '--help']], [[...create, '--help']]])(
    '[FR-ADM-05] %j prints the commands and exits 0 without running anything',
    async (argv) => {
      const result = await cli(argv, {});
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('admin:create --email <email> --name <name>');
    },
  );

  it('[FR-ADM-05] an unreachable database is exit 3 with ERROR UNAVAILABLE', async () => {
    const result = await cli(create, envFor('postgresql://po_app:unused@127.0.0.1:9/none'));
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/^ERROR UNAVAILABLE: /);
    expect(result.stdout).toBe('');
  });
});
