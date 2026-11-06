import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { DEMO_PASSWORD, DEMO_USERS, seedDemoUsers } from '../../src/migrate/seed-demo.js';
import { accountsHarness } from '../support/accounts.js';
import { testLogger } from '../support/log-capture.js';

// Demo data for local stacks (FR-037): two Buyers and one Approver, never an admin, never
// in production, created once.

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

async function setup() {
  const h = await accountsHarness();
  const prisma = createPrismaClient({
    url: h.db.url('po_app'),
    poolSize: 2,
    connectionTimeoutMs: 2_000,
  });
  clients.push(prisma);
  const seed = (appEnv: 'local' | 'production' = 'local') =>
    seedDemoUsers({ prisma, appEnv, logger: testLogger() });
  return { h, seed };
}

describe('[NFR-OPS-01] demo users', () => {
  it('[NFR-OPS-01] creates two active Buyers and one active Approver, and no admin', async () => {
    const { h, seed } = await setup();
    expect(await seed()).toBe(3);
    expect(await h.query('SELECT email, roles, status FROM users ORDER BY email')).toEqual([
      { email: 'approver@example.com', roles: ['APPROVER'], status: 'ACTIVE' },
      { email: 'buyer1@example.com', roles: ['BUYER'], status: 'ACTIVE' },
      { email: 'buyer2@example.com', roles: ['BUYER'], status: 'ACTIVE' },
    ]);
    expect(DEMO_USERS.every((user) => !user.roles.includes('ADMIN'))).toBe(true);
  });

  it('[NFR-OPS-01] each demo user logs in with the demo password', async () => {
    const { h, seed } = await setup();
    await seed();
    for (const user of DEMO_USERS) {
      const res = await h.login(user.email, DEMO_PASSWORD);
      expect(res.status, user.email).toBe(200);
      expect(res.body).toMatchObject({ email: user.email, roles: user.roles });
    }
  });

  it('[NFR-OPS-01] runs again without creating or changing anyone', async () => {
    const { h, seed } = await setup();
    await seed();
    // A change since the first run, made as the superuser outside the audit.
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(`UPDATE users SET roles = '{APPROVER}' WHERE email = 'buyer1@example.com'`);
    await h.query('COMMIT');
    expect(await seed()).toBe(0);
    expect(await h.query('SELECT count(*)::int AS n FROM users')).toEqual([{ n: 3 }]);
    expect(await h.query(`SELECT roles FROM users WHERE email = 'buyer1@example.com'`)).toEqual([
      { roles: ['APPROVER'] },
    ]);
  });

  it('[NFR-OPS-01] refuses to run in production', async () => {
    const { h, seed } = await setup();
    await expect(seed('production')).rejects.toThrow(/production/);
    expect(await h.query('SELECT id FROM users')).toEqual([]);
  });
});
