import type { Logger } from 'pino';
import { ROLE, type UserRole, type VendorBody } from '@po/contracts';
import { hashPassword } from '../auth/passwords.js';
import type { AppEnv } from '../config/rules.js';
import type { AppPrismaClient } from '../db/client.js';
import { ONE_SHOT } from '../db/one-shot.js';
import { withTransaction, type AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';
import { insertUserIfAbsent } from '../users/repository.js';
import { SYSTEM_ACTOR } from '../users/actor.js';
import { writeAudit } from '../audit/write.js';
import { insertVendor, setVendorStatus } from '../vendors/repository.js';
import { fieldsOf, toSnapshot } from '../vendors/snapshot.js';

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
      const row = await insertVendor(tx, fieldsOf(body));
      if (!row) continue;
      created += 1;
      await writeAudit(tx, {
        action: 'VENDOR_CREATED',
        entityType: 'vendor',
        entityId: row.id,
        details: { before: null, after: toSnapshot(row) },
      });
      if (inactive) {
        const changed = await setVendorStatus(tx, row.id, 'INACTIVE');
        await writeAudit(tx, {
          action: 'VENDOR_DEACTIVATED',
          entityType: 'vendor',
          entityId: row.id,
          details: { before: toSnapshot(row), after: toSnapshot(changed) },
        });
      }
    }
    return created;
  });
}
