import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { ADMIN_LOCK } from '../../src/db/locks.js';
import { accountsHarness, APP_ORIGIN, type AccountsHarness } from '../support/accounts.js';

const OPERATOR = { osUser: 'deploy', host: 'ops-host-1' };

async function cli(h: AccountsHarness, argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    env: { APP_ENV: 'local', APP_ORIGIN, DATABASE_URL: h.db.url('po_app'), LOG_LEVEL: 'error' },
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

async function admins(h: AccountsHarness) {
  return h.query<{ email: string; status: string; deactivated: boolean; version: number }>(
    `SELECT email, status, deactivated_at IS NOT NULL AS deactivated, version
       FROM users WHERE roles = '{ADMIN}' ORDER BY email`,
  );
}

function audits(h: AccountsHarness) {
  return h.query('SELECT action, actor_type, entity_id, details FROM audit_entries');
}

describe('[FR-ADM-05] admin:deactivate', () => {
  it('[FR-ADM-05] deactivates one of two admins, ends their sessions and audits it as the operator', async () => {
    const h = await accountsHarness();
    const leaving = await h.seedUser({ roles: '{ADMIN}', name: 'Leaving Admin' });
    const staying = await h.seedUser({ roles: '{ADMIN}', name: 'Staying Admin' });
    const jar = await h.loggedIn(leaving);
    await h.loggedIn(leaving);
    await h.loggedIn(staying);

    const result = await cli(h, ['admin:deactivate', '--email', leaving.email.toUpperCase()]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Admin deactivated: ${leaving.email} (2 sessions ended)\n`);

    expect(
      await h.query(
        `SELECT status, deactivated_at IS NOT NULL AS deactivated, version FROM users WHERE id = $1`,
        [leaving.id],
      ),
    ).toEqual([{ status: 'DEACTIVATED', deactivated: true, version: 2 }]);
    expect(
      await h.query(
        `SELECT u.email, s.revoke_reason FROM sessions s JOIN users u ON u.id = s.user_id
          ORDER BY u.email = $1 DESC`,
        [leaving.email],
      ),
    ).toEqual([
      { email: leaving.email, revoke_reason: 'DEACTIVATED' },
      { email: leaving.email, revoke_reason: 'DEACTIVATED' },
      { email: staying.email, revoke_reason: null },
    ]);
    expect(await audits(h)).toEqual([
      {
        action: 'USER_DEACTIVATED',
        actor_type: 'OPERATOR',
        entity_id: leaving.id,
        details: {
          before: 'ACTIVE',
          after: 'DEACTIVATED',
          sessionsRevoked: 2,
          osUser: OPERATOR.osUser,
          host: OPERATOR.host,
        },
      },
    ]);

    // The ended session no longer works, and the admin can't log in again.
    expect((await h.get('/me', jar)).status).toBe(401);
    const again = await h.login(leaving.email, leaving.password);
    expect(again.status).toBe(401);
    expect(again.body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
  });

  it('[FR-ADM-05] the last active admin is LAST_ADMIN, exit 2, and nothing changes', async () => {
    const h = await accountsHarness();
    const only = await h.seedUser({ roles: '{ADMIN}' });
    await h.seedUser({ roles: '{ADMIN}', status: 'DEACTIVATED' });
    await h.loggedIn(only);

    const result = await cli(h, ['admin:deactivate', '--email', only.email]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^ERROR LAST_ADMIN: /);
    expect(await h.query('SELECT status, version FROM users WHERE id = $1', [only.id])).toEqual([
      { status: 'ACTIVE', version: 1 },
    ]);
    expect(await h.query('SELECT 1 FROM sessions WHERE revoked_at IS NOT NULL')).toHaveLength(0);
    expect(await audits(h)).toEqual([]);
  });

  it('[FR-ADM-05] two concurrent deactivations of the last two admins leave one active', async () => {
    const h = await accountsHarness();
    const first = await h.seedUser({ roles: '{ADMIN}' });
    const second = await h.seedUser({ roles: '{ADMIN}' });

    const results = await Promise.all([
      cli(h, ['admin:deactivate', '--email', first.email]),
      cli(h, ['admin:deactivate', '--email', second.email]),
    ]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 2]);
    expect(results.find((r) => r.code === 2)?.stderr).toMatch(/^ERROR LAST_ADMIN: /);
    expect((await admins(h)).map((a) => a.status).sort()).toEqual(['ACTIVE', 'DEACTIVATED']);
    expect(await audits(h)).toHaveLength(1);
  });

  it('[FR-ADM-05] waits for ADMIN_LOCK before reading the admins', async () => {
    const h = await accountsHarness();
    const first = await h.seedUser({ roles: '{ADMIN}' });
    await h.seedUser({ roles: '{ADMIN}' });

    const holder = await h.db.client('postgres');
    await holder.query('SELECT pg_advisory_lock($1)', [ADMIN_LOCK.toString()]);
    const pending = cli(h, ['admin:deactivate', '--email', first.email]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await h.query('SELECT status FROM users WHERE id = $1', [first.id])).toEqual([
      { status: 'ACTIVE' },
    ]);
    await holder.query('SELECT pg_advisory_unlock($1)', [ADMIN_LOCK.toString()]);

    expect((await pending).code).toBe(0);
    expect(await h.query('SELECT status FROM users WHERE id = $1', [first.id])).toEqual([
      { status: 'DEACTIVATED' },
    ]);
  });

  it('[FR-ADM-05] an already deactivated admin is a message, exit 0, and nothing changes', async () => {
    const h = await accountsHarness();
    await h.seedUser({ roles: '{ADMIN}' });
    const gone = await h.seedUser({ roles: '{ADMIN}', status: 'DEACTIVATED' });

    const result = await cli(h, ['admin:deactivate', '--email', gone.email]);
    expect(result).toEqual({
      code: 0,
      stdout: `Admin already deactivated: ${gone.email}; nothing changed\n`,
      stderr: '',
    });
    expect(await h.query('SELECT version FROM users WHERE id = $1', [gone.id])).toEqual([
      { version: 1 },
    ]);
    expect(await audits(h)).toEqual([]);
  });
});

describe('[FR-ADM-05] admin:reactivate', () => {
  it('[FR-ADM-05] reactivates a deactivated admin, clears deactivated_at and audits it as the operator', async () => {
    const h = await accountsHarness();
    await h.seedUser({ roles: '{ADMIN}' });
    const back = await h.seedUser({ roles: '{ADMIN}', status: 'DEACTIVATED' });

    const result = await cli(h, ['admin:reactivate', '--email', back.email]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Admin reactivated: ${back.email}\n`);
    expect(
      await h.query(
        `SELECT status, deactivated_at IS NOT NULL AS deactivated, version FROM users WHERE id = $1`,
        [back.id],
      ),
    ).toEqual([{ status: 'ACTIVE', deactivated: false, version: 2 }]);
    expect(await audits(h)).toEqual([
      {
        action: 'USER_REACTIVATED',
        actor_type: 'OPERATOR',
        entity_id: back.id,
        details: {
          before: 'DEACTIVATED',
          after: 'ACTIVE',
          sessionsRevoked: 0,
          osUser: OPERATOR.osUser,
          host: OPERATOR.host,
        },
      },
    ]);
    expect((await h.login(back.email, back.password)).status).toBe(200);
  });

  it('[FR-ADM-05] an already active admin is a message, exit 0, and nothing changes', async () => {
    const h = await accountsHarness();
    const active = await h.seedUser({ roles: '{ADMIN}' });

    const result = await cli(h, ['admin:reactivate', '--email', active.email]);
    expect(result).toEqual({
      code: 0,
      stdout: `Admin already active: ${active.email}; nothing changed\n`,
      stderr: '',
    });
    expect(await h.query('SELECT version FROM users WHERE id = $1', [active.id])).toEqual([
      { version: 1 },
    ]);
    expect(await audits(h)).toEqual([]);
  });
});

describe('[FR-ADM-05] admin:deactivate and admin:reactivate refusals', () => {
  it.each(['admin:deactivate', 'admin:reactivate'])(
    '[FR-ADM-05] %s on a non-admin account is NOT_AN_ADMIN, exit 2, and nothing changes',
    async (command) => {
      const h = await accountsHarness();
      await h.seedUser({ roles: '{ADMIN}' });
      const buyer = await h.seedUser({ roles: '{BUYER}' });
      const deactivatedBuyer = await h.seedUser({ roles: '{BUYER}', status: 'DEACTIVATED' });

      for (const email of [buyer.email, deactivatedBuyer.email]) {
        const result = await cli(h, [command, '--email', email]);
        expect(result.code, email).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/^ERROR NOT_AN_ADMIN: /);
        // The message doesn't echo the email: error output isn't redacted.
        expect(result.stderr).not.toContain(email);
      }
      expect(await h.query('SELECT version FROM users WHERE version <> 1')).toEqual([]);
      expect(await audits(h)).toEqual([]);
    },
  );

  it.each(['admin:deactivate', 'admin:reactivate'])(
    '[FR-ADM-05] %s on an email no account has is USER_NOT_FOUND, exit 2, and nothing changes',
    async (command) => {
      const h = await accountsHarness();
      await h.seedUser({ roles: '{ADMIN}' });
      await h.seedUser({ roles: '{ADMIN}' });

      const result = await cli(h, [command, '--email', 'Nobody@Example.local']);
      expect(result).toEqual({
        code: 2,
        stdout: '',
        stderr: 'ERROR USER_NOT_FOUND: no account has that email; nothing was changed\n',
      });
      expect(await h.query('SELECT version FROM users WHERE version <> 1')).toEqual([]);
      expect(await audits(h)).toEqual([]);
    },
  );

  it.each([
    ['a missing --email', ['admin:deactivate'], /^ERROR USAGE: .*Usage: admin:deactivate/],
    [
      'an unknown flag',
      ['admin:reactivate', '--email', 'x@example.local', '--name', 'X'],
      /^ERROR USAGE: .*Usage: admin:reactivate/,
    ],
    [
      'an invalid email',
      ['admin:deactivate', '--email', 'not-an-email'],
      /^ERROR INVALID_ARGUMENT: --email/,
    ],
  ])('[FR-ADM-05] %s is exit 1 with a usage or argument error', async (_case, argv, stderr) => {
    const h = await accountsHarness();
    const result = await cli(h, argv);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(stderr);
  });

  it.each([['admin:deactivate'], ['admin:reactivate']])(
    '[FR-ADM-05] %s against an unreachable database is exit 3 with ERROR UNAVAILABLE',
    async (command) => {
      let stderr = '';
      const code = await runCli([command, '--email', 'x@example.local'], {
        env: {
          APP_ENV: 'local',
          APP_ORIGIN,
          DATABASE_URL: 'postgresql://po_app:unused@127.0.0.1:9/none',
          LOG_LEVEL: 'error',
        },
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
        ...OPERATOR,
      });
      expect(code).toBe(3);
      expect(stderr).toMatch(/^ERROR UNAVAILABLE: /);
    },
  );

  it('[FR-ADM-05] --help lists both commands', async () => {
    let stdout = '';
    await runCli(['--help'], {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
      ...OPERATOR,
    });
    expect(stdout).toContain('admin:deactivate --email <email>');
    expect(stdout).toContain('admin:reactivate --email <email>');
  });
});
