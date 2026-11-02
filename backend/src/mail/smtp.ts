import nodemailer from 'nodemailer';
import type { ApiConfig } from '../config/api.js';
import type { Mailer } from './mailer.js';
import { renderMail } from './template.js';

export type SmtpSettings = Pick<
  ApiConfig,
  | 'APP_ENV'
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'SMTP_SECURE'
  | 'SMTP_USER'
  | 'SMTP_PASSWORD'
  | 'MAIL_FROM'
>;

/** How long one send may wait on the mail server; it runs after the response is sent. */
const SMTP_TIMEOUT_MS = 10_000;

/**
 * Sends through SMTP with nodemailer. Nothing connects until the first send: the settings
 * are validated at startup, and an unreachable server fails sends, not the API (spec edge
 * case). A failure rejects send; the MailDispatcher logs it, a direct caller must.
 *
 * In production the connection must be TLS: implicit with SMTP_SECURE, otherwise STARTTLS
 * is required, so a server (or a man in the middle) that doesn't offer it gets neither the
 * credentials nor the message. Locally, Mailpit speaks plain text.
 */
export function createSmtpMailer(settings: SmtpSettings): Mailer {
  const transport = nodemailer.createTransport({
    host: settings.SMTP_HOST,
    port: settings.SMTP_PORT,
    secure: settings.SMTP_SECURE,
    requireTLS: settings.APP_ENV === 'production',
    // Config guarantees the user and password come together.
    ...(settings.SMTP_USER !== undefined && settings.SMTP_PASSWORD !== undefined
      ? { auth: { user: settings.SMTP_USER, pass: settings.SMTP_PASSWORD } }
      : {}),
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send(message) {
      const mail = renderMail(message);
      await transport.sendMail({
        from: settings.MAIL_FROM,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
  };
}
