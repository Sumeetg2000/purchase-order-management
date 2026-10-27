import type { Logger } from 'pino';
import type { TransactionHooks } from '../db/transaction.js';
import { logSecurityEvent } from '../observability/security-log.js';
import type { Mailer } from './mailer.js';
import { assertPlainRecipient, type MailMessage, type MailVariables } from './template.js';

/**
 * Sends a message once the transaction commits, never inside it (ADR-0017): a rolled-back
 * change sends nothing. A failed send is logged as a mail_send_failed security event and
 * swallowed: the change already happened, and the user can ask again (resend, forgot
 * password). There's no outbox (ADR-0019). A recipient that isn't a plain address throws
 * InvalidRecipientError here, inside the transaction, so nothing is scheduled.
 */
export function sendAfterCommit<V extends MailVariables>(
  hooks: TransactionHooks,
  { mailer, logger, message }: { mailer: Mailer; logger: Logger; message: MailMessage<V> },
): void {
  assertPlainRecipient(message.to);
  hooks.afterCommit(async () => {
    try {
      await mailer.send(message);
    } catch (error) {
      // Only what identifies the failure: an SMTP error's text can name the recipient.
      const failure = error as { name?: unknown; code?: unknown; responseCode?: unknown };
      logSecurityEvent(logger, 'mail_send_failed', {
        template: message.template.name,
        errorName: failure.name,
        errorCode: failure.code,
        responseCode: failure.responseCode,
      });
    }
  });
}
