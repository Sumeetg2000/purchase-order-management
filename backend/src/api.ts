import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import type { ApiConfig } from './config/api.js';
import { createPrismaClient } from './db/client.js';
import { createApp } from './http/app.js';
import { listMigrations } from './http/routes/health.js';
import { productionRoutes } from './http/routes/index.js';
import { createShutdown } from './http/shutdown.js';
import { createMailDispatcher } from './mail/dispatcher.js';
import { createSmtpMailer } from './mail/smtp.js';
import { createMetrics, createMetricsServer } from './observability/metrics.js';

// Below compose's stop_grace_period for api, so the drain finishes before SIGKILL.
const DRAIN_TIMEOUT_MS = 10_000;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export interface RunningApi {
  /** The API's port (the configured one, or the one assigned for port 0). */
  port: number;
  metricsPort: number;
  /** Drains in-flight requests and mail, and closes the pool; the same as on SIGTERM. */
  close: () => Promise<void>;
}

/**
 * Starts the API and its metrics listener from a validated config. Nothing here contacts
 * the mail server: an unreachable SMTP host fails sends, not startup.
 */
export async function startApi(config: ApiConfig, logger: Logger): Promise<RunningApi> {
  const prisma = createPrismaClient({
    url: config.DATABASE_URL,
    poolSize: config.DB_POOL_SIZE,
    connectionTimeoutMs: config.DB_TX_MAX_WAIT_MS,
  });

  const mail = createMailDispatcher(createSmtpMailer(config));
  const metrics = createMetrics();
  const app = createApp({
    logger,
    appOrigin: config.APP_ORIGIN,
    metrics,
    routes: productionRoutes({
      prisma,
      expectedMigrations: await listMigrations(),
      logger,
      mail,
    }),
  });

  const server = createServer(app);
  const metricsServer = createMetricsServer(metrics);
  const close = createShutdown({
    servers: [server, metricsServer],
    prisma,
    logger,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    mail,
  });

  // If either listener fails to start, close whatever did start before rejecting: the
  // caller gets no handle to close it with.
  try {
    const port = await listen(server, config.HTTP_PORT);
    logger.info({ port }, 'api listening');
    const metricsPort = await listen(metricsServer, config.METRICS_PORT);
    logger.info({ port: metricsPort }, 'metrics listening');
    return { port, metricsPort, close };
  } catch (error) {
    await close();
    throw error;
  }
}
