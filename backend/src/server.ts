import { createServer, type Server } from 'node:http';
import { apiConfig } from './config/api.js';
import { loadConfig } from './config/load.js';
import { createPrismaClient } from './db/client.js';
import { createApp } from './http/app.js';
import { healthRoutes, listMigrations } from './http/routes/health.js';
import { createShutdown } from './http/shutdown.js';
import { createLogger } from './observability/logger.js';
import { createMetrics, createMetricsServer } from './observability/metrics.js';

// Below compose's stop_grace_period for api, so the drain finishes before SIGKILL.
const DRAIN_TIMEOUT_MS = 10_000;

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function main() {
  const config = loadConfig(apiConfig.schema);
  if (!config) return;
  const logger = createLogger(config.LOG_LEVEL);

  const prisma = createPrismaClient({
    url: config.DATABASE_URL,
    poolSize: config.DB_POOL_SIZE,
    connectionTimeoutMs: config.DB_TX_MAX_WAIT_MS,
  });

  const metrics = createMetrics();
  const app = createApp({
    metrics,
    routes: [...healthRoutes({ prisma, expectedMigrations: await listMigrations(), logger })],
  });

  const server = createServer(app);
  await listen(server, config.HTTP_PORT);
  logger.info({ port: config.HTTP_PORT }, 'api listening');

  const metricsServer = createMetricsServer(metrics);
  await listen(metricsServer, config.METRICS_PORT);
  logger.info({ port: config.METRICS_PORT }, 'metrics listening');

  const shutdown = createShutdown({
    servers: [server, metricsServer],
    prisma,
    logger,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'signal received');
      shutdown().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'shutdown failed');
          process.exit(1);
        },
      );
    });
  }
}

main().catch((error: unknown) => {
  createLogger().fatal({ err: error }, 'api failed to start');
  process.exit(1);
});
