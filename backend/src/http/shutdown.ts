import type { Server } from 'node:http';
import type { Logger } from 'pino';

export interface ShutdownOptions {
  /** Every listener of the process (API and metrics). */
  servers: readonly Server[];
  prisma: { $disconnect: () => Promise<void> };
  logger: Logger;
  /** How long in-flight requests may run before their connections are cut. */
  drainTimeoutMs: number;
}

function closeServer(server: Server, drainTimeoutMs: number): Promise<boolean> {
  if (!server.listening) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve(false);
    }, drainTimeoutMs);
    // close() stops accepting at once, ends idle keep-alive sockets, and calls back
    // once every in-flight request has finished.
    server.close(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Returns the shutdown routine for SIGTERM and SIGINT: stop accepting, drain in-flight
 * requests up to the timeout, then close the database pool. Calling it again returns the
 * same promise, so a second signal can't close the pool under a draining request.
 */
export function createShutdown({ servers, prisma, logger, drainTimeoutMs }: ShutdownOptions) {
  let running: Promise<void> | undefined;

  return function shutdown(): Promise<void> {
    running ??= (async () => {
      logger.info('shutdown: draining');
      const drained = await Promise.all(servers.map((s) => closeServer(s, drainTimeoutMs)));
      if (drained.includes(false)) {
        logger.warn({ drainTimeoutMs }, 'shutdown: drain timed out; open connections were closed');
      }
      await prisma.$disconnect();
      logger.info('shutdown: complete');
    })();
    return running;
  };
}
