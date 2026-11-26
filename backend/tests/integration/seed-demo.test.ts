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
import { systemClock } from '../../src/lib/clock.js';
import { createReportsService } from '../../src/reports/service.js';
import { reconciliationViolations } from '../support/setup.js';
import { accountsHarness } from '../support/accounts.js';
import { testLogger } from '../support/log-capture.js';

// Demo data for local stacks (FR-037): two Buyers and one Approver, never an admin, never
// in production, created once.

// Per demo Buyer: three drafts, and one order in each of six approval states.
const DEMO_ORDER_COUNT = 2 * (3 + 6);

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
    expect(await seedOrders()).toBe(DEMO_ORDER_COUNT);
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
        WHERE o.current_round IS NULL
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
    ).toEqual([{ n: DEMO_ORDER_COUNT }]);
    expect(await reconciliationViolations(h.db)).toEqual([]);
  });

  it('[FR-PO-01] runs again without raising anything', async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    await seedOrders();
    const audit = await h.query('SELECT count(*)::int AS n FROM audit_entries');
    expect(await seedOrders()).toBe(0);
    expect(await h.query('SELECT count(*)::int AS n FROM purchase_orders')).toEqual([
      { n: DEMO_ORDER_COUNT },
    ]);
    expect(await h.query('SELECT count(*)::int AS n FROM audit_entries')).toEqual(audit);
  });

  it('[FR-PO-01] refuses to run in production', async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    await expect(seedOrders('production')).rejects.toThrow(/production/);
    expect(await h.query('SELECT id FROM purchase_orders')).toEqual([]);
  });
});

describe('[FR-SM-01] demo orders in each reachable approval state', () => {
  it('[FR-SM-01] each demo Buyer has one pending, auto-approved, step-approved, rejected, withdrawn and cancelled order, made through the services', async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    await seedOrders();
    const rows = await h.query<{
      email: string;
      status: string;
      outcome: string | null;
      steps: string[];
      decider: string | null;
      reason: string | null;
    }>(
      `SELECT u.email, o.status, r.outcome,
              coalesce(array_agg(s.state ORDER BY s.step) FILTER (WHERE s.step IS NOT NULL), '{}')
                AS steps,
              max(d.email) AS decider, coalesce(max(s.reason), r.withdraw_reason) AS reason
         FROM purchase_orders o
         JOIN users u ON u.id = o.owner_id
         JOIN approval_rounds r ON r.order_id = o.id
         LEFT JOIN approval_steps s ON s.order_id = r.order_id AND s.round = r.round
         LEFT JOIN users d ON d.id = s.decided_by
        GROUP BY u.email, o.id, o.status, r.round, r.outcome, r.withdraw_reason
        ORDER BY u.email, o.po_number`,
    );
    for (const email of ['buyer1@example.com', 'buyer2@example.com']) {
      expect(
        rows
          .filter((r) => r.email === email)
          .map(({ status, outcome, steps, decider, reason }) => ({
            status,
            outcome,
            steps,
            decider,
            reason,
          })),
        email,
      ).toEqual([
        { status: 'PENDING_APPROVAL', outcome: null, steps: ['OPEN'], decider: null, reason: null },
        { status: 'APPROVED', outcome: 'AUTO_APPROVED', steps: [], decider: null, reason: null },
        {
          status: 'APPROVED',
          outcome: 'APPROVED',
          steps: ['APPROVED'],
          decider: 'approver@example.com',
          reason: null,
        },
        {
          status: 'REJECTED',
          outcome: 'REJECTED',
          steps: ['REJECTED'],
          decider: 'approver@example.com',
          reason: expect.any(String) as string,
        },
        {
          status: 'DRAFT',
          outcome: 'WITHDRAWN',
          steps: ['VOIDED'],
          decider: null,
          reason: expect.any(String) as string,
        },
        {
          status: 'CANCELLED',
          outcome: 'APPROVED',
          steps: ['APPROVED'],
          decider: 'approver@example.com',
          reason: null,
        },
      ]);
    }
    // The decisions are the Demo Approver's, the auto-approvals the system's.
    expect(
      await h.query(
        `SELECT action, actor_type, acting_role, count(*)::int AS n FROM audit_entries
          WHERE action IN ('PO_AUTO_APPROVED', 'APPROVAL_STEP_APPROVED', 'APPROVAL_STEP_REJECTED',
                           'PO_WITHDRAWN', 'PO_SUBMITTED', 'PO_CANCELLED')
          GROUP BY action, actor_type, acting_role ORDER BY action`,
      ),
    ).toEqual([
      { action: 'APPROVAL_STEP_APPROVED', actor_type: 'USER', acting_role: 'APPROVER', n: 4 },
      { action: 'APPROVAL_STEP_REJECTED', actor_type: 'USER', acting_role: 'APPROVER', n: 2 },
      { action: 'PO_AUTO_APPROVED', actor_type: 'SYSTEM', acting_role: null, n: 2 },
      // Slice 5: the Demo Approver cancels one approved order per demo Buyer.
      { action: 'PO_CANCELLED', actor_type: 'USER', acting_role: 'APPROVER', n: 2 },
      { action: 'PO_SUBMITTED', actor_type: 'USER', acting_role: 'BUYER', n: 12 },
      { action: 'PO_WITHDRAWN', actor_type: 'USER', acting_role: 'BUYER', n: 2 },
    ]);
    expect(await reconciliationViolations(h.db)).toEqual([]);
  });
});

describe('[FR-RCV-01] demo receipts', () => {
  it('[FR-RCV-01] each demo Buyer has one partly and one fully received approved order, and the cancelled order partly received before its cancel, through the receipt service', async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    await seedOrders();
    const progress = () =>
      h.query<{
        email: string;
        status: string;
        outcome: string;
        receipts: number;
        ordered: number;
        received: number;
        before_cancel: boolean | null;
      }>(
        `SELECT u.email, o.status, r.outcome,
                (SELECT count(*)::int FROM goods_receipts g WHERE g.order_id = o.id) AS receipts,
                (SELECT sum(quantity)::int FROM order_lines l WHERE l.order_id = o.id) AS ordered,
                (SELECT sum(received_quantity)::int FROM order_lines l WHERE l.order_id = o.id)
                  AS received,
                (SELECT bool_and(g.recorded_at < o.cancelled_at) FROM goods_receipts g
                  WHERE g.order_id = o.id) AS before_cancel
           FROM purchase_orders o
           JOIN users u ON u.id = o.owner_id
           JOIN approval_rounds r ON r.order_id = o.id AND r.outcome IN ('APPROVED', 'AUTO_APPROVED')
          ORDER BY u.email, o.po_number`,
      );
    const seeded = await progress();
    for (const email of ['buyer1@example.com', 'buyer2@example.com']) {
      expect(
        seeded.filter((r) => r.email === email),
        email,
      ).toEqual([
        // Fully received over two receipts.
        {
          email,
          status: 'APPROVED',
          outcome: 'AUTO_APPROVED',
          receipts: 2,
          ordered: 10,
          received: 10,
          before_cancel: null,
        },
        // Partly received.
        {
          email,
          status: 'APPROVED',
          outcome: 'APPROVED',
          receipts: 1,
          ordered: 2,
          received: 1,
          before_cancel: null,
        },
        // Partly received, then cancelled.
        {
          email,
          status: 'CANCELLED',
          outcome: 'APPROVED',
          receipts: 1,
          ordered: 3,
          received: 1,
          before_cancel: true,
        },
      ]);
    }
    // Each receipt recorded by the order's Buyer, as the receipt service records it.
    expect(
      await h.query(
        `SELECT a.actor_type, a.acting_role, count(*)::int AS n
           FROM audit_entries a
          WHERE a.action = 'GOODS_RECEIPT_RECORDED'
          GROUP BY a.actor_type, a.acting_role`,
      ),
    ).toEqual([{ actor_type: 'USER', acting_role: 'BUYER', n: 8 }]);
    expect(
      await h.query(
        `SELECT count(*)::int AS n FROM goods_receipts g
           JOIN purchase_orders o ON o.id = g.order_id WHERE g.recorded_by <> o.owner_id`,
      ),
    ).toEqual([{ n: 0 }]);
    // A reseed records nothing more.
    await seedOrders();
    expect(await progress()).toEqual(seeded);
    expect(await reconciliationViolations(h.db)).toEqual([]);
  });
});

describe('[FR-RPT-01] demo data in the outstanding report', () => {
  it("[FR-RPT-01] each demo Buyer's partly received approved order is outstanding; the fully received and cancelled ones are not", async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    await seedOrders();
    const prisma = createPrismaClient({
      url: h.db.url('po_app'),
      poolSize: 2,
      connectionTimeoutMs: 2_000,
    });
    clients.push(prisma);
    const reports = createReportsService({ prisma, clock: systemClock });
    const page = await reports.listOutstandingOrders(
      {
        userId: '00000000-0000-7000-8000-000000000001',
        sessionId: '00000000-0000-7000-8000-000000000002',
        name: 'Ada Admin',
        email: 'ada@example.local',
        roles: ['ADMIN'],
      },
      { page: 1, pageSize: 50 },
    );
    expect(
      page.items
        .map((o) => ({
          owner: o.owner.name,
          openLineCount: o.openLineCount,
          outstandingQuantity: o.outstandingQuantity,
          ageBucket: o.ageBucket,
        }))
        .sort((a, b) => a.owner.localeCompare(b.owner)),
    ).toEqual(
      DEMO_USERS.filter((u) => u.roles.includes('BUYER'))
        .map((u) => ({
          owner: u.name,
          openLineCount: 1,
          outstandingQuantity: 1,
          ageBucket: 'DAYS_0_30',
        }))
        .sort((a, b) => a.owner.localeCompare(b.owner)),
    );
  });
});

describe('[FR-APR-05] demo orders under a changed policy', () => {
  it('[FR-APR-05] under a raised tier, an order the submit approved is never decided', async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    // The operator raised the tier above every demo order before the seed ran.
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query('INSERT INTO approval_policies (version) VALUES (2)');
    await h.query(
      `INSERT INTO approval_policy_tiers (policy_version, tier, threshold) VALUES (2, 1, 300000)`,
    );
    await h.query('COMMIT');

    expect(await seedOrders()).toBe(DEMO_ORDER_COUNT);
    expect(
      await h.query(
        `SELECT o.status, r.outcome, r.policy_version, count(*)::int AS n
           FROM purchase_orders o JOIN approval_rounds r ON r.order_id = o.id
          GROUP BY o.status, r.outcome, r.policy_version ORDER BY o.status`,
      ),
    ).toEqual([
      { status: 'APPROVED', outcome: 'AUTO_APPROVED', policy_version: 2, n: 10 },
      // Cancel is no approval decision: the order to be cancelled still is.
      { status: 'CANCELLED', outcome: 'AUTO_APPROVED', policy_version: 2, n: 2 },
    ]);
    expect(
      await h.query(
        `SELECT count(*)::int AS n FROM audit_entries
          WHERE action LIKE 'APPROVAL_STEP_%' OR action = 'PO_WITHDRAWN'`,
      ),
    ).toEqual([{ n: 0 }]);
    expect(await reconciliationViolations(h.db)).toEqual([]);
  });
});

describe('[FR-APR-05] demo orders under a two-tier policy', () => {
  it('[FR-APR-05] the approved and the cancelled demo orders are approved step by step; every Buyer is seeded', async () => {
    const { h, seed, seedVendors, seedOrders } = await setup();
    await seed();
    await seedVendors();
    // Two tiers below every routed demo order: each needs two approvals.
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query('INSERT INTO approval_policies (version) VALUES (2)');
    await h.query(
      `INSERT INTO approval_policy_tiers (policy_version, tier, threshold)
       VALUES (2, 1, 50000), (2, 2, 100000)`,
    );
    await h.query('COMMIT');

    expect(await seedOrders()).toBe(DEMO_ORDER_COUNT);
    const rows = await h.query<{ email: string; status: string; steps: string[] }>(
      `SELECT u.email, o.status,
              array_agg(s.state ORDER BY s.step) FILTER (WHERE s.step IS NOT NULL) AS steps
         FROM purchase_orders o
         JOIN users u ON u.id = o.owner_id
         JOIN approval_rounds r ON r.order_id = o.id AND r.round = o.current_round
         LEFT JOIN approval_steps s ON s.order_id = r.order_id AND s.round = r.round
        WHERE o.status IN ('APPROVED', 'CANCELLED') AND r.outcome = 'APPROVED'
        GROUP BY u.email, o.id, o.status
        ORDER BY u.email, o.status`,
    );
    expect(rows).toEqual(
      ['buyer1@example.com', 'buyer2@example.com'].flatMap((email) => [
        { email, status: 'APPROVED', steps: ['APPROVED', 'APPROVED'] },
        { email, status: 'CANCELLED', steps: ['APPROVED', 'APPROVED'] },
      ]),
    );
    expect(await reconciliationViolations(h.db)).toEqual([]);
  });
});
