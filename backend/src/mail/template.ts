import { emailAddressSchema } from '@po/contracts';

// Mail templates (ADR-0017): text and HTML from typed variables. Every variable is
// HTML-escaped before the HTML part sees it, so a name like "<b>" can't inject markup.
// Slice 0 defines no real templates; slice 1 adds verification and reset mail.

export type MailVariables = Record<string, string>;

export interface MailTemplate<V extends MailVariables> {
  /** Identifies the template in logs; never the recipient. */
  name: string;
  subject: (variables: V) => string;
  text: (variables: V) => string;
  /** Receives the variables HTML-escaped. */
  html: (escaped: V) => string;
}

export function defineTemplate<V extends MailVariables>(template: MailTemplate<V>) {
  return template;
}

export interface MailMessage<V extends MailVariables> {
  template: MailTemplate<V>;
  to: string;
  variables: V;
}

/** A message ready to hand to a transport. */
export interface RenderedMail {
  template: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** A recipient that isn't a plain address. The message never names it: it's personal data. */
export class InvalidRecipientError extends Error {
  override readonly name = 'InvalidRecipientError';

  constructor() {
    super('The recipient is not a plain email address');
  }
}

/**
 * Refuses anything but a plain address (the contracts' emailAddressSchema), so no mail
 * library's address parser can find extra recipients in it.
 */
export function assertPlainRecipient(to: string): void {
  if (!emailAddressSchema.safeParse(to).success) throw new InvalidRecipientError();
}

export function renderMail<V extends MailVariables>(message: MailMessage<V>): RenderedMail {
  const { template, to, variables } = message;
  assertPlainRecipient(to);
  const escaped = Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [key, escapeHtml(value)]),
  ) as V;
  return {
    template: template.name,
    to,
    subject: template.subject(variables),
    text: template.text(variables),
    html: template.html(escaped),
  };
}
