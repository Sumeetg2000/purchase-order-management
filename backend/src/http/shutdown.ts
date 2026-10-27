import type { Server } from 'node:http';
import type { Logger } from 'pino';
import type { MailDispatcher } from '../mail/dispatcher.js';

/**
 * The API's whole shutdown deadline: in-flight requests, then mail still sending. Below
 * compose's stop_grace_period for api (a test pins it), so it ends before SIGKILL.
 */
export const DRAIN_TIMEOUT_MS = 10_000;

/**
 * The part of the deadline kept for mail: requests get the rest, so a stuck request can't
 * use up the time of mail already sending.
 */
export const MAIL_RESERVE_MS = 2_000;

export interface ShutdownOptions {
  /** Every listener of the process (API and metrics). */
  servers: readonly Server[];
  prisma: { $disconnect: () => Promise<void> };
  logger: Logger;
  /**
   * How long in-flight requests, and then mail still sending after its response, may run
   * before they are cut off. One deadline covers both.
   */
  drainTimeoutMs: number;
  mail?: ShutdownMail;
}

/** Mail still sending at shutdown, and the listener its handlers run on. */
export interface ShutdownMail {
  dispatcher: Pick<MailDispatcher, 'settle'>;
  /**
   * The listener whose handlers dispatch mail (the API, not metrics); one of `servers`.
   * Only a request cut off there can still dispatch, so only its drain timing out makes
   * shutdown wait out the mail reserve.
   */
  from: Server;
  /** The end of the deadline kept for mail (default MAIL_RESERVE_MS). */
  reserveMs?: number;
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
 * requests and then mail still sending, up to the timeout, then close the database pool.
 * Calling it again returns the same promise, so a second signal can't close the pool under
 * a draining request.
 */
export function createShutdown({ servers, prisma, logger, drainTimeoutMs, mail }: ShutdownOptions) {
  if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0) {
    throw new RangeError('the drain deadline must be a positive finite time');
  }
  const mailReserveMs = mail?.reserveMs ?? MAIL_RESERVE_MS;
  const reserveFits =
    Number.isFinite(mailReserveMs) && mailReserveMs > 0 && mailReserveMs < drainTimeoutMs;
  if (mail && !reserveFits) {
    throw new RangeError('the mail reserve must be a positive time shorter than the deadline');
  }
  if (mail && !servers.includes(mail.from)) {
    throw new RangeError('the mail listener must be one of the servers shutdown closes');
  }
  let running: Promise<void> | undefined;

  return function shutdown(): Promise<void> {
    running ??= (async () => {
      logger.info('shutdown: draining');
      // A monotonic clock: a wall-clock step (NTP) can't stretch or shrink the deadline.
      const deadline = performance.now() + drainTimeoutMs;
      const requestsMs = mail ? Math.max(0, drainTimeoutMs - mailReserveMs) : drainTimeoutMs;
      const drained = await Promise.all(servers.map((s) => closeServer(s, requestsMs)));
      const cutOff = servers.filter((_, i) => drained[i] === false);
      if (cutOff.length > 0) {
        logger.warn(
          { drainTimeoutMs, requestsMs },
          'shutdown: drain timed out; open connections were closed',
        );
      }
      // A request the drain cut off can still commit and dispatch mail: wait out the rest
      // of the deadline for it rather than returning as soon as nothing is in flight.
      await mail?.dispatcher.settle(Math.max(0, deadline - performance.now()), {
        untilTimeout: cutOff.includes(mail.from),
      });
      await prisma.$disconnect();
      logger.info('shutdown: complete');
    })();
    return running;
  };
}

export interface SignalOptions {
  logger: Logger;
  target?: NodeJS.EventEmitter;
  exit?: (code: number) => void;
}

/**
 * Runs `shutdown` on SIGTERM or SIGINT, then exits 0 (or 1 if it fails). The listeners
 * stay registered, so a repeated signal is logged and ignored instead of falling back to
 * Node's default action, which would kill the process mid-drain.
 */
export function onShutdownSignals(
  shutdown: () => Promise<void>,
  { logger, target = process, exit = (code) => process.exit(code) }: SignalOptions,
): void {
  let running: Promise<void> | undefined;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    target.on(signal, () => {
      if (running) {
        logger.info({ signal }, 'signal received; shutdown already in progress');
        return;
      }
      logger.info({ signal }, 'signal received');
      running = shutdown();
      running.then(
        () => {
          exit(0);
        },
        (error: unknown) => {
          logger.error({ err: error }, 'shutdown failed');
          exit(1);
        },
      );
    });
  }
}
