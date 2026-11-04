import type { Logger } from 'pino';
import { ROLE, type UserRole } from '@po/contracts';
import { hashPassword } from '../auth/passwords.js';
import type { AppEnv } from '../config/rules.js';
import type { AppPrismaClient } from '../db/client.js';
import { ONE_SHOT } from '../db/one-shot.js';
import { withTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';
import { insertUserIfAbsent } from '../users/repository.js';

// Demo users for local stacks (migrate step 4 with SEED_DEMO_DATA=true, FR-037): two
// Buyers and one Approver, never an admin. Users that exist are left as they are, so a
// restart changes nothing. The config refuses SEED_DEMO_DATA in production; this refuses
// again, in case it is ever called another way.

/** The password every demo user logs in with (local stacks only; documented in quickstart). */
export const DEMO_PASSWORD = 'po demo passphrase';

export const DEMO_USERS: readonly { email: string; name: string; roles: readonly UserRole[] }[] = [
  { email: 'buyer1@example.com', name: 'Demo Buyer One', roles: [ROLE.BUYER] },
  { email: 'buyer2@example.com', name: 'Demo Buyer Two', roles: [ROLE.BUYER] },
  { email: 'approver@example.com', name: 'Demo Approver', roles: [ROLE.APPROVER] },
];

/** Creates the demo users that don't exist yet; returns how many it created. */
export async function seedDemoUsers(options: {
  prisma: AppPrismaClient;
  appEnv: AppEnv;
  logger: Logger;
}): Promise<number> {
  if (options.appEnv === 'production') {
    throw new Error('demo users are never seeded in production');
  }
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  return withTransaction(
    {
      prisma: options.prisma,
      actor: { type: 'SYSTEM' },
      requestId: uuidv7(),
      timeoutMs: ONE_SHOT.transactionTimeoutMs,
      maxWaitMs: ONE_SHOT.transactionMaxWaitMs,
      logger: options.logger,
    },
    async (tx) => {
      let created = 0;
      for (const user of DEMO_USERS) {
        if (await insertUserIfAbsent(tx, { ...user, passwordHash })) created += 1;
      }
      return created;
    },
  );
}
