import type { MailMessage, MailVariables } from './template.js';

/**
 * The one way to send mail (ADR-0017, research R14). Callers never send inside a
 * transaction: they use sendAfterCommit, so a rolled-back change sends nothing.
 */
export interface Mailer {
  send<V extends MailVariables>(message: MailMessage<V>): Promise<void>;
}
