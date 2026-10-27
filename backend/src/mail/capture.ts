import type { Mailer } from './mailer.js';
import { renderMail, type MailMessage, type MailVariables, type RenderedMail } from './template.js';

/** A Mailer for tests: renders each message and keeps it, sending nothing. */
export class CaptureMailer implements Mailer {
  readonly sent: RenderedMail[] = [];

  send<V extends MailVariables>(message: MailMessage<V>): Promise<void> {
    this.sent.push(renderMail(message));
    return Promise.resolve();
  }
}
