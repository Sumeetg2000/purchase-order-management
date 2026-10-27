import type { Logger } from 'pino';
import type { TransactionHooks } from '../db/transaction.js';
import type { MailDispatcher } from './dispatcher.js';
import { assertPlainRecipient, type MailMessage, type MailVariables } from './template.js';

/**
 * Dispatches a message once the transaction commits, never inside it (ADR-0017): a
 * rolled-back change sends nothing, and the send itself runs after the response (see
 * MailDispatcher). A recipient that isn't a plain address throws InvalidRecipientError
 * here, inside the transaction, so nothing is scheduled.
 */
export function sendAfterCommit<V extends MailVariables>(
  hooks: TransactionHooks,
  { mail, logger, message }: { mail: MailDispatcher; logger: Logger; message: MailMessage<V> },
): void {
  assertPlainRecipient(message.to);
  hooks.afterCommit(() => {
    mail.dispatch(message, logger);
  });
}
