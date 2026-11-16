import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import {
  DEMO_PASSWORD,
  DEMO_USERS,
  DEMO_VENDORS,
  seedDemoOrders,
  seedDemoUsers,
  seedDemoVendors,
} from '../../src/migrate/seed-demo.js';
import { reconciliationViolations } from '../support/setup.js';
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
  const seedVendors = (appEnv: 'local' | 'production' = 'local') =>
    seedDemoVendors({ prisma, appEnv, logger: testLogger() });
  const seedOrders = (appEnv: 'local' | 'production' = 'local') =>
    seedDemoOrders({ prisma, appEnv, logger: testLogger() });
  return { h, seed, seedVendors, seedOrders };
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

// Demo vendors (FR-018): one per payment-term type, one inactive, one without a phone,
// created by the system through the audited path, never in production, created once.
describe('[FR-VEN-01] demo vendors', () => {
  it('[FR-VEN-01] covers each payment-term type, one inactive vendor and one without a phone', async () => {
    const { h, seedVendors } = await setup();
    expect(await seedVendors()).toBe(DEMO_VENDORS.length);
    const rows = await h.query<{
      name: string;
      payment_term_type: string;
      status: string;
      contact_phone: string | null;
    }>('SELECT name, payment_term_type, status, contact_phone FROM vendors ORDER BY name_key');
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.payment_term_type))).toEqual(
      new Set(['NET', 'ADVANCE', 'PARTIAL_ADVANCE']),
    );
    expect(rows.filter((r) => r.status === 'INACTIVE')).toHaveLength(1);
    expect(rows.filter((r) => r.contact_phone === null)).toHaveLength(1);
  });

  it('[FR-VEN-01] each vendor has a system-made created entry; the inactive one also a deactivation', async () => {
    const { h, seedVendors } = await setup();
    await seedVendors();
    const entries = await h.query<{ action: string; actor_type: string }>(
      `SELECT action, actor_type FROM audit_entries WHERE entity_type = 'vendor' ORDER BY id`,
    );
    expect(entries.filter((e) => e.action === 'VENDOR_CREATED')).toHaveLength(5);
    expect(entries.filter((e) => e.action === 'VENDOR_DEACTIVATED')).toHaveLength(1);
    expect(entries).toHaveLength(6);
    expect(entries.every((e) => e.actor_type === 'SYSTEM')).toBe(true);
  });

  it('[FR-VEN-01] runs again without creating, changing or auditing anything', async () => {
    const { h, seedVendors } = await setup();
    await seedVendors();
    const before = await h.query('SELECT id, version, status FROM vendors ORDER BY id');
    expect(await seedVendors()).toBe(0);
    expect(await h.query('SELECT id, version, status FROM vendors ORDER BY id')).toEqual(before);
    expect(
      await h.query(`SELECT count(*)::int AS n FROM audit_entries WHERE entity_type = 'vendor'`),
    ).toEqual([{ n: 6 }]);
  });

  it('[FR-VEN-01] refuses to run in production', async () => {
    const { h, seedVendors } = await setup();
    await expect(seedVendors('production')).rejects.toThrow(/production/);
    expect(await h.query('SELECT id FROM vendors')).toEqual([]);
  });
});

describe('[FR-PO-01] demo orders', () => {
  it('[FR-PO-01] each demo Buyer gets three drafts: exact fractional totals, 20 lines, and one with a vendor since deactivated', async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    expect(await seedOrders()).toBe(6);
    const orders = await h.query<{
      email: string;
      vendor: string;
      status: string;
      lines: number;
      total: string;
    }>(
      `SELECT u.email, v.name AS vendor, v.status, count(l.id)::int AS lines, o.total::text AS total
         FROM purchase_orders o JOIN users u ON u.id = o.owner_id JOIN vendors v ON v.id = o.vendor_id
         JOIN order_lines l ON l.order_id = o.id
        GROUP BY u.email, v.name, v.status, o.id, o.total ORDER BY u.email, o.po_number`,
    );
    const buyers = DEMO_USERS.filter((u) => u.roles.includes('BUYER')).map((u) => u.email);
    expect(orders).toHaveLength(6);
    for (const email of buyers) {
      const own = orders.filter((o) => o.email === email);
      expect(own.map((o) => [o.vendor, o.status, o.lines])).toEqual([
        ['Acme Supplies', 'ACTIVE', 3],
        ['Bright Office Goods', 'ACTIVE', 20],
        ['Frontier Hardware', 'INACTIVE', 2],
      ]);
      expect(own[0]?.total).toBe('0.3000');
    }
    // Raised through the service as each Buyer: one PO_CREATED each, by that Buyer.
    expect(
      await h.query(
        `SELECT count(*)::int AS n FROM audit_entries
          WHERE action = 'PO_CREATED' AND acting_role = 'BUYER' AND actor_type = 'USER'`,
      ),
    ).toEqual([{ n: 6 }]);
    expect(await reconciliationViolations(h.db)).toEqual([]);
  });

  it('[FR-PO-01] runs again without raising anything', async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    await seedOrders();
    expect(await seedOrders()).toBe(0);
    expect(await h.query('SELECT count(*)::int AS n FROM purchase_orders')).toEqual([{ n: 6 }]);
  });

  it('[FR-PO-01] refuses to run in production', async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    await expect(seedOrders('production')).rejects.toThrow(/production/);
    expect(await h.query('SELECT id FROM purchase_orders')).toEqual([]);
  });
});
