import type { Logger } from 'pino';
import { logSecurityEvent } from '../observability/security-log.js';
import type { Mailer } from './mailer.js';
import type { MailMessage, MailVariables } from './template.js';

export interface MailDispatcher {
  /**
   * Starts a send and returns at once, so the response never waits on the mail server
   * (ADR-0017). A failed send is logged as a mail_send_failed security event and
   * swallowed: the change already happened, and the user can ask again (resend, forgot
   * password). There's no outbox (ADR-0019).
   */
  dispatch: <V extends MailVariables>(message: MailMessage<V>, logger: Logger) => void;
  /** Resolves once every send started so far has finished or failed. */
  settled: () => Promise<void>;
}

export function createMailDispatcher(mailer: Mailer): MailDispatcher {
  const inFlight = new Set<Promise<void>>();
  return {
    dispatch(message, logger) {
      const sending = mailer.send(message).catch((error: unknown) => {
        // Only what identifies the failure: an SMTP error's text can name the recipient.
        // A mailer can reject with anything, null included.
        const failure: { name?: unknown; code?: unknown; responseCode?: unknown } =
          typeof error === 'object' && error !== null ? error : {};
        logSecurityEvent(logger, 'mail_send_failed', {
          template: message.template.name,
          errorName: failure.name,
          errorCode: failure.code,
          responseCode: failure.responseCode,
        });
      });
      inFlight.add(sending);
      void sending.finally(() => inFlight.delete(sending));
    },
    async settled() {
      await Promise.all(inFlight);
    },
  };
}
