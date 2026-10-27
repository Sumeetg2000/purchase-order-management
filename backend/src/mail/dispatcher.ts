import type { Logger } from 'pino';
import { logSecurityEvent, type SecurityEvent } from '../observability/security-log.js';
import type { Mailer } from './mailer.js';
import type { MailMessage, MailTemplateName, MailVariables } from './template.js';

export interface MailDispatcher {
  /**
   * Starts a send and returns at once, so the response never waits on the mail server
   * (ADR-0017). A failed send is logged as a mail_send_failed security event and
   * swallowed: the change already happened, and the user can ask again (resend, forgot
   * password). There's no outbox (ADR-0019).
   */
  dispatch: <V extends MailVariables>(message: MailMessage<V>, logger: Logger) => void;
  /** Resolves once nothing is in flight, including sends dispatched while it waits. */
  settled: () => Promise<void>;
  /**
   * For shutdown: waits up to `timeoutMs` for the sends in flight, then gives up on the
   * rest, logging each as mail_send_abandoned: it may still be delivered, so not failed.
   * Mail dispatched after that isn't sent, and is logged as mail_send_abandoned too.
   */
  settle: (timeoutMs: number) => Promise<void>;
}

interface InFlight {
  template: MailTemplateName;
  logger: Logger;
  abandoned: boolean;
}

/**
 * Logs a mail security event without ever throwing: a send's promise must not reject, or
 * settling (and so shutdown) would fail and the rejection would go unhandled.
 */
function record(logger: Logger, event: SecurityEvent, fields: Record<string, unknown>): void {
  try {
    logSecurityEvent(logger, event, fields);
  } catch {
    // The log itself is failing; there is nowhere left to report this.
  }
}

export function createMailDispatcher(mailer: Mailer): MailDispatcher {
  const inFlight = new Map<Promise<void>, InFlight>();
  // Set once shutdown has stopped waiting: the process is about to exit.
  let closed = false;
  // Loops until nothing is in flight, so sends dispatched while it waits are included.
  const settled = async () => {
    while (inFlight.size > 0) await Promise.all(inFlight.keys());
  };
  return {
    dispatch(message, logger) {
      if (closed) {
        record(logger, 'mail_send_abandoned', { template: message.template.name });
        return;
      }
      const entry: InFlight = { template: message.template.name, logger, abandoned: false };
      // Called inside a promise, so a mailer that throws instead of rejecting is caught too.
      const sending = Promise.resolve()
        .then(() => mailer.send(message))
        .catch((error: unknown) => {
          if (entry.abandoned) return;
          // Only what identifies the failure: an SMTP error's text can name the recipient.
          // A mailer can reject with anything, null included.
          const failure: { name?: unknown; code?: unknown; responseCode?: unknown } =
            typeof error === 'object' && error !== null ? error : {};
          record(logger, 'mail_send_failed', {
            template: entry.template,
            errorName: failure.name,
            errorCode: failure.code,
            responseCode: failure.responseCode,
          });
        });
      inFlight.set(sending, entry);
      void sending.finally(() => inFlight.delete(sending));
    },
    settled,
    async settle(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<true>((resolve) => {
        timer = setTimeout(() => {
          resolve(true);
        }, timeoutMs);
      });
      const expired = await Promise.race([settled().then(() => false), timedOut]);
      clearTimeout(timer);
      closed = true;
      if (!expired) return;
      for (const entry of inFlight.values()) {
        entry.abandoned = true;
        record(entry.logger, 'mail_send_abandoned', { template: entry.template });
      }
      inFlight.clear();
    },
  };
}
