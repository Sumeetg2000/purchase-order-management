import { readdir } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { AppPrismaClient } from '../db/client.js';
import { classifyDbError } from '../db/errors.js';
import { createHealthRepository } from './repository.js';

// From src/health or dist/health up to the backend root.
const MIGRATIONS_DIR = new URL('../../prisma/migrations/', import.meta.url);

/** The migrations shipped with this build, in the order Prisma applies them. */
export async function listMigrations(dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export interface HealthDependencies {
  prisma: AppPrismaClient;
  /** Every migration directory in this build; each must be applied for readiness. */
  expectedMigrations: readonly string[];
  logger?: Logger;
  /** Readiness answers 503 if the database hasn't replied within this time. */
  timeoutMs?: number;
}

export type NotReady = 'database' | 'migrations';

export interface ReadinessService {
  /** What keeps the API from being ready, or undefined when it is. */
  check: () => Promise<NotReady | undefined>;
}

class ReadinessTimeoutError extends Error {
  override readonly name = 'ReadinessTimeoutError';
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ReadinessTimeoutError(`no reply within ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

export function createReadinessService({
  prisma,
  expectedMigrations,
  logger,
  timeoutMs = 2_000,
}: HealthDependencies): ReadinessService {
  const repository = createHealthRepository(prisma);
  return {
    check: async () => {
      let rows;
      try {
        rows = await withDeadline(repository.migrationRows(), timeoutMs);
      } catch (error) {
        logger?.warn(
          { err: error, kind: classifyDbError(error) },
          'readiness: database check failed',
        );
        return 'database';
      }

      const applied = new Set(
        rows.filter((r) => r.finished && !r.rolled_back).map((r) => r.migration_name),
      );
      const failed = rows.filter((r) => !r.finished && !r.rolled_back).map((r) => r.migration_name);
      const pending = expectedMigrations.filter((name) => !applied.has(name));
      if (failed.length > 0 || pending.length > 0) {
        logger?.warn({ failed, pending }, 'readiness: migrations incomplete');
        return 'migrations';
      }
      return undefined;
    },
  };
}
