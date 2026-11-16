import type { Logger } from 'pino';
import { createOrderBody, ROLE, type UserRole, type VendorBody } from '@po/contracts';
import { hashPassword } from '../auth/passwords.js';
import type { AppEnv } from '../config/rules.js';
import type { AppPrismaClient } from '../db/client.js';
import { ONE_SHOT } from '../db/one-shot.js';
import {
  createTransactionRunner,
  withTransaction,
  type AuditedTransaction,
} from '../db/transaction.js';
import { createOrdersService } from '../orders/service.js';
import { listOrders } from '../orders/repository.js';
import { uuidv7 } from '../lib/uuid.js';
import { findUserByEmail, insertUserIfAbsent } from '../users/repository.js';
import { findVendorByNameKey, selectVendor } from '../vendors/repository.js';
import { SYSTEM_ACTOR } from '../users/actor.js';
import { changeAuditedStatus, createAuditedVendor, TRANSITIONS } from '../vendors/service.js';
import { fieldsOf } from '../vendors/snapshot.js';

// Demo data for local stacks (migrate step 4 with SEED_DEMO_DATA=true): two Buyers and one
// Approver, never an admin, and five demo vendors. Users and vendors that exist are left as
// they are, so a restart changes nothing. The config refuses SEED_DEMO_DATA in production; this refuses
// again, in case it is ever called another way.

/** The password every demo user logs in with (local stacks only; documented in quickstart). */
export const DEMO_PASSWORD = 'po demo passphrase';

export const DEMO_USERS: readonly { email: string; name: string; roles: readonly UserRole[] }[] = [
  { email: 'buyer1@example.com', name: 'Demo Buyer One', roles: [ROLE.BUYER] },
  { email: 'buyer2@example.com', name: 'Demo Buyer Two', roles: [ROLE.BUYER] },
  { email: 'approver@example.com', name: 'Demo Approver', roles: [ROLE.APPROVER] },
];

/** What every seed step needs. */
interface SeedOptions {
  prisma: AppPrismaClient;
  appEnv: AppEnv;
  logger: Logger;
}

/** One audited transaction as the system; refuses production. */
function asSystem<T>(
  options: SeedOptions,
  what: string,
  fn: (tx: AuditedTransaction) => Promise<T>,
): Promise<T> {
  if (options.appEnv === 'production') {
    return Promise.reject(new Error(`demo ${what} are never seeded in production`));
  }
  return withTransaction(
    {
      prisma: options.prisma,
      actor: SYSTEM_ACTOR,
      requestId: uuidv7(),
      timeoutMs: ONE_SHOT.transactionTimeoutMs,
      maxWaitMs: ONE_SHOT.transactionMaxWaitMs,
      logger: options.logger,
    },
    fn,
  );
}

/** Creates the demo users that don't exist yet; returns how many it created. */
export function seedDemoUsers(options: SeedOptions): Promise<number> {
  return asSystem(options, 'users', async (tx) => {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    let created = 0;
    for (const user of DEMO_USERS) {
      if (await insertUserIfAbsent(tx, { ...user, passwordHash })) created += 1;
    }
    return created;
  });
}

type DemoVendor = VendorBody & { inactive?: true };

/** One per payment-term type, one inactive, one without a phone. */
export const DEMO_VENDORS: readonly DemoVendor[] = [
  {
    name: 'Acme Supplies',
    contactName: 'Ravi Shah',
    contactEmail: 'ravi@acme.example',
    contactPhone: '+91 22 4000 1000',
    paymentTerms: { type: 'NET', netDays: 30 },
  },
  {
    name: 'Bright Office Goods',
    contactName: 'Meera Iyer',
    contactEmail: 'meera@brightoffice.example',
    contactPhone: '+91 80 4100 2000',
    paymentTerms: { type: 'ADVANCE' },
  },
  {
    name: 'Coastal Logistics',
    contactName: 'Arjun Menon',
    contactEmail: 'arjun@coastal.example',
    contactPhone: '+91 484 410 3000',
    paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 40, netDays: 45 },
  },
  {
    name: 'Delta Packaging',
    contactName: 'Nisha Rao',
    contactEmail: 'nisha@deltapack.example',
    contactPhone: null,
    paymentTerms: { type: 'NET', netDays: 60 },
  },
  {
    name: 'Evergreen Stationers',
    contactName: 'Kabir Das',
    contactEmail: 'kabir@evergreen.example',
    contactPhone: '+91 33 4200 5000',
    paymentTerms: { type: 'NET', netDays: 15 },
    inactive: true,
  },
];

/**
 * Creates the demo vendors whose names are free, audited as the system, and deactivates
 * the inactive one; returns how many it created. A vendor that exists is left as it is.
 */
export function seedDemoVendors(options: SeedOptions): Promise<number> {
  return asSystem(options, 'vendors', async (tx) => {
    let created = 0;
    for (const { inactive, ...body } of DEMO_VENDORS) {
      const row = await createAuditedVendor(tx, fieldsOf(body));
      if (!row) continue;
      created += 1;
      if (inactive) await changeAuditedStatus(tx, row, TRANSITIONS.deactivate);
    }
    return created;
  });
}

/** The vendor of the demo draft whose vendor is deactivated after it was raised. */
export const DEMO_LATER_INACTIVE_VENDOR: VendorBody = {
  name: 'Frontier Hardware',
  contactName: 'Tara Bose',
  contactEmail: 'tara@frontier.example',
  contactPhone: null,
  paymentTerms: { type: 'NET', netDays: 30 },
};

/** Each demo Buyer's drafts: exact fractional totals, a long order, and the later-inactive vendor. */
const DEMO_DRAFTS: readonly {
  vendor: string;
  lines: { description: string; quantity: number; unitPrice: string }[];
}[] = [
  {
    vendor: 'Acme Supplies',
    lines: Array.from({ length: 3 }, (_, i) => ({
      description: `Sample washer pack ${String(i + 1)}`,
      quantity: 1,
      unitPrice: '0.1',
    })),
  },
  {
    vendor: 'Bright Office Goods',
    lines: Array.from({ length: 20 }, (_, i) => ({
      description: `Office supply item ${String(i + 1)}`,
      quantity: i + 1,
      unitPrice: '12.75',
    })),
  },
  {
    vendor: DEMO_LATER_INACTIVE_VENDOR.name,
    lines: [
      { description: 'Hex bolts M8', quantity: 100, unitPrice: '2.4' },
      { description: 'Spring washers M8', quantity: 100, unitPrice: '0.35' },
    ],
  },
];

/**
 * Raises three drafts for each demo Buyer who has none, through the order service as that
 * Buyer (so each has its PO number and PO_CREATED), then deactivates the vendor of the
 * third. Returns how many it raised; a Buyer with orders is left as they are.
 */
export async function seedDemoOrders(options: SeedOptions): Promise<number> {
  if (options.appEnv === 'production') {
    throw new Error('demo orders are never seeded in production');
  }
  const later = await asSystem(options, 'orders', async (tx) => {
    const existing = await findVendorByNameKey(tx, DEMO_LATER_INACTIVE_VENDOR.name);
    if (existing) return existing.id;
    const created = await createAuditedVendor(tx, fieldsOf(DEMO_LATER_INACTIVE_VENDOR));
    if (!created) throw new Error('the later-inactive demo vendor could not be created');
    return created.id;
  });
  const vendorIds = await asSystem(options, 'orders', async (tx) => {
    const ids = new Map<string, string>();
    for (const { vendor } of DEMO_DRAFTS) {
      const found = await findVendorByNameKey(tx, vendor);
      if (!found) throw new Error(`demo vendor ${vendor} is missing: seed the vendors first`);
      ids.set(vendor, found.id);
    }
    return ids;
  });
  const orders = createOrdersService({
    prisma: options.prisma,
    transactions: createTransactionRunner({
      prisma: options.prisma,
      timeoutMs: ONE_SHOT.transactionTimeoutMs,
      maxWaitMs: ONE_SHOT.transactionMaxWaitMs,
    }),
  });
  let raised = 0;
  for (const demo of DEMO_USERS.filter((u) => u.roles.includes(ROLE.BUYER))) {
    const user = await asSystem(options, 'orders', (tx) => findUserByEmail(tx, demo.email));
    if (!user) throw new Error(`demo user ${demo.email} is missing: seed the users first`);
    const buyer = {
      userId: user.id,
      sessionId: uuidv7(),
      name: demo.name,
      email: demo.email,
      roles: demo.roles,
    };
    const { total } = await listOrders(
      options.prisma,
      { kind: 'own', userId: user.id },
      {},
      { offset: 0, limit: 1 },
    );
    if (total > 0) continue;
    for (const draft of DEMO_DRAFTS) {
      const vendorId = vendorIds.get(draft.vendor) ?? '';
      const body = createOrderBody.parse({ vendorId, lines: draft.lines });
      await orders.createOrder(
        buyer,
        { body, idempotencyKey: uuidv7() },
        { requestId: uuidv7(), logger: options.logger, ip: '127.0.0.1', userAgent: 'seed-demo' },
      );
      raised += 1;
    }
  }
  await asSystem(options, 'orders', async (tx) => {
    const vendor = await selectVendor(tx, later, 'update');
    if (vendor && vendor.status === 'ACTIVE') {
      await changeAuditedStatus(tx, vendor, TRANSITIONS.deactivate);
    }
  });
  return raised;
}
