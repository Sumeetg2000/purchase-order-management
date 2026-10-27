import type { Logger } from 'pino';
import type { AppPrismaClient } from '../db/client.js';
import { lockAdmins } from '../db/locks.js';
import { ONE_SHOT } from '../db/one-shot.js';
import { withTransaction } from '../db/transaction.js';
import type { CliErrorCode } from '../lib/operator-codes.js';
import { uuidv7 } from '../lib/uuid.js';
import { logOneTimeLink } from '../observability/logger.js';
import { RESET_TOKEN_LIFETIME_MINUTES } from '../tokens/one-time.js';
import { createAdmin, EmailInUseError } from '../users/create-admin.js';
import { adminExists } from '../users/repository.js';

// The first administrator (migrate step 3, research R13, contracts/cli.md). Idempotent:
// under ADMIN_LOCK it does nothing if any administrator exists, so restarts, and two
// starts at once, still give exactly one admin and one printed link.

export class BootstrapError extends Error {
  override readonly name = 'BootstrapError';

  constructor(
    readonly code: Extract<CliErrorCode, 'BOOTSTRAP_SETTINGS_MISSING' | 'EMAIL_IN_USE'>,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface BootstrapOptions {
  /** A po_app client: the bootstrap needs no more than the API's own rights. */
  prisma: AppPrismaClient;
  email?: string | undefined;
  name?: string | undefined;
  appOrigin: string;
  logger: Logger;
  timeoutMs?: number;
  maxWaitMs?: number;
}

export async function runBootstrap(options: BootstrapOptions): Promise<'created' | 'skipped'> {
  const { prisma, email, name, appOrigin, logger } = options;
  return withTransaction(
    {
      prisma,
      actor: { type: 'SYSTEM' },
      requestId: uuidv7(),
      timeoutMs: options.timeoutMs ?? ONE_SHOT.transactionTimeoutMs,
      maxWaitMs: options.maxWaitMs ?? ONE_SHOT.transactionMaxWaitMs,
      logger,
    },
    async (tx, hooks) => {
      await lockAdmins(tx);
      if (await adminExists(tx)) return 'skipped';
      if (!email || !name) {
        throw new BootstrapError(
          'BOOTSTRAP_SETTINGS_MISSING',
          'No administrator exists, and BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_NAME are not both set',
        );
      }
      let link: string;
      try {
        ({ link } = await createAdmin(tx, { email, name, source: 'bootstrap', appOrigin }));
      } catch (error) {
        if (error instanceof EmailInUseError) {
          throw new BootstrapError(
            'EMAIL_IN_USE',
            'BOOTSTRAP_ADMIN_EMAIL belongs to a user who is not an administrator; nobody was promoted',
            { cause: error },
          );
        }
        throw error;
      }
      // Only once the admin is committed, so a rolled-back run never shows a link.
      hooks.afterCommit(() => {
        logOneTimeLink(
          logger,
          link,
          `First administrator created. One-time set-password link (valid ${String(RESET_TOKEN_LIFETIME_MINUTES)} minutes, shown once)`,
        );
      });
      return 'created';
    },
  );
}
