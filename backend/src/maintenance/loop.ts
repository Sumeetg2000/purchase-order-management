import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { loadConfig } from '../config/load.js';
import { maintenanceConfig } from '../config/maintenance.js';
import { createPrismaClient } from '../db/client.js';
import { ONE_SHOT } from '../db/one-shot.js';
import { onShutdownSignals } from '../http/shutdown.js';
import { createLogger } from '../observability/logger.js';
import { runPurge } from './purge.js';
import { purgeTasks } from './registry.js';

// setTimeout clamps delays above 2^31-1 ms (about 24.8 days) to 1 ms, so longer waits
// are chained.
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface MaintenanceLoopOptions {
  /** One purge run; it logs its own outcome. */
  run: () => Promise<unknown>;
  logger: Logger;
  intervalMs: number;
}

/**
 * Runs the purge at start and then every interval, measured from the end of the previous
 * run so runs never overlap. A failed run is logged and the loop carries on.
 */
export function startMaintenanceLoop({ run, logger, intervalMs }: MaintenanceLoopOptions) {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();

  const tick = () => {
    current = run().then(
      () => undefined,
      (error: unknown) => {
        logger.error({ err: error }, 'purge run failed');
      },
    );
    void current.then(() => {
      if (!stopped) wait(intervalMs);
    });
  };
  const wait = (remainingMs: number) => {
    const step = Math.min(remainingMs, MAX_TIMER_MS);
    timer = setTimeout(() => {
      if (remainingMs > step) wait(remainingMs - step);
      else tick();
    }, step);
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
    connectionTimeoutMs: ONE_SHOT.connectionTimeoutMs,
  });
  const intervalMs = config.PURGE_INTERVAL_HOURS * 60 * 60 * 1_000;
  logger.info(
    { intervalHours: config.PURGE_INTERVAL_HOURS, tasks: purgeTasks.length },
    'maintenance started',
  );
  const loop = startMaintenanceLoop({
    run: () =>
      runPurge({ tasks: purgeTasks, db, lockUrl: config.MAINTENANCE_DATABASE_URL, logger }),
    logger,
    intervalMs,
  });

  onShutdownSignals(
    async () => {
      logger.info('maintenance stopping');
      await loop.stop();
      await db.$disconnect();
    },
    { logger },
  );
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
