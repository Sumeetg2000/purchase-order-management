import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { loadConfig } from '../config/load.js';
import { maintenanceConfig } from '../config/maintenance.js';
import { createPrismaClient, type AppPrismaClient } from '../db/client.js';
import { createLogger } from '../observability/logger.js';
import { purgeTasks, type PurgeTask } from './registry.js';

/** Runs every task once and logs one line with the per-task counts. */
export async function runPurgeCycle(
  tasks: readonly PurgeTask[],
  db: AppPrismaClient,
  logger: Logger,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.name] = await task.run(db);
  }
  logger.info({ counts }, 'purge run complete');
  return counts;
}

export interface MaintenanceLoopOptions {
  tasks: readonly PurgeTask[];
  db: AppPrismaClient;
  logger: Logger;
  intervalMs: number;
}

/**
 * Runs the purge at start and then every interval, measured from the end of the previous
 * run so runs never overlap. A failed run is logged and the loop carries on.
 */
export function startMaintenanceLoop({ tasks, db, logger, intervalMs }: MaintenanceLoopOptions) {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();

  const tick = () => {
    current = runPurgeCycle(tasks, db, logger).then(
      () => undefined,
      (error: unknown) => {
        logger.error({ err: error }, 'purge run failed');
      },
    );
    void current.then(() => {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  tick();

  return {
    /** Cancels the next run and waits for the current one to finish. */
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}

function main(): void {
  const config = loadConfig(maintenanceConfig.schema);
  if (!config) return;
  const logger = createLogger(config.LOG_LEVEL);

  const db = createPrismaClient({
    url: config.MAINTENANCE_DATABASE_URL,
    poolSize: 2,
    connectionTimeoutMs: 5_000,
  });
  const intervalMs = config.PURGE_INTERVAL_HOURS * 60 * 60 * 1_000;
  logger.info(
    { intervalHours: config.PURGE_INTERVAL_HOURS, tasks: purgeTasks.length },
    'maintenance started',
  );
  const loop = startMaintenanceLoop({ tasks: purgeTasks, db, logger, intervalMs });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'maintenance stopping');
      loop
        .stop()
        .then(() => db.$disconnect())
        .then(
          () => process.exit(0),
          (error: unknown) => {
            logger.error({ err: error }, 'maintenance shutdown failed');
            process.exit(1);
          },
        );
    });
  }
}

// Run only as the process entrypoint, not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    createLogger().fatal({ err: error }, 'maintenance failed to start');
    process.exit(1);
  }
}
