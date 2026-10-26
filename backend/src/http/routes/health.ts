import { readdir } from 'node:fs/promises';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AppPrismaClient } from '../../db/client.js';
import { classifyDbError } from '../../db/errors.js';
import { defineRoute, type RouteDefinition } from '../define-route.js';
import { sendProblem } from '../problem.js';

// From src/http/routes or dist/http/routes up to the backend root.
const MIGRATIONS_DIR = new URL('../../../prisma/migrations/', import.meta.url);

/** The migrations shipped with this build, in the order Prisma applies them. */
export async function listMigrations(dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const healthSchema = z.object({ status: z.literal('ok') });
const readinessSchema = z.object({
  status: z.literal('ready'),
  checks: z.object({ database: z.literal('ok'), migrations: z.literal('ok') }),
});

interface MigrationRow {
  migration_name: string;
  finished: boolean;
  rolled_back: boolean;
}

export interface HealthDependencies {
  prisma: AppPrismaClient;
  /** Every migration directory in this build; each must be applied for readiness. */
  expectedMigrations: readonly string[];
  logger?: Logger;
  /** Readiness answers 503 if the database hasn't replied within this time. */
  timeoutMs?: number;
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

type NotReady = 'database' | 'migrations';

export function healthRoutes({
  prisma,
  expectedMigrations,
  logger,
  timeoutMs = 2_000,
}: HealthDependencies): RouteDefinition[] {
  async function check(): Promise<NotReady | undefined> {
    let rows: MigrationRow[];
    try {
      // One query proves the database answers and reads the migration state.
      rows = await withDeadline(
        prisma.$queryRaw<MigrationRow[]>`
          SELECT migration_name,
                 finished_at IS NOT NULL AS finished,
                 rolled_back_at IS NOT NULL AS rolled_back
            FROM _prisma_migrations`,
        timeoutMs,
      );
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
  }

  return [
    defineRoute({
      method: 'get',
      path: '/healthz',
      operationId: 'getHealth',
      summary: 'Liveness. The process is up and serving.',
      access: 'public',
      responses: { 200: healthSchema },
      handler: (_req, res) => {
        res.json({ status: 'ok' });
      },
    }),
    defineRoute({
      method: 'get',
      path: '/readyz',
      operationId: 'getReadiness',
      summary: 'Readiness. The database is reachable and migrations are complete.',
      access: 'public',
      responses: {
        200: readinessSchema,
        503: z.object({ code: z.literal('SERVICE_UNAVAILABLE') }),
      },
      handler: async (_req, res) => {
        const notReady = await check();
        if (notReady) {
          sendProblem(res, {
            status: 503,
            code: 'SERVICE_UNAVAILABLE',
            title: 'Service unavailable',
            detail:
              notReady === 'database'
                ? 'The database is not reachable.'
                : 'Migrations are not complete.',
          });
          return;
        }
        res.json({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
      },
    }),
  ];
}
