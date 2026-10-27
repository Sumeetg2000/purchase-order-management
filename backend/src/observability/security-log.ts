import type { Logger } from 'pino';

// Security events (ADR-0017): structured log entries marked security: true, separate from
// the business audit. Each carries the request id through the request's logger, and never
// a token, password, phone number or recipient address. Slice 1 adds the account events.

// mail_send_abandoned: shutdown stopped waiting for a send, so its outcome is unknown.
export const SECURITY_EVENTS = ['mail_send_failed', 'mail_send_abandoned'] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

export function logSecurityEvent(
  logger: Logger,
  event: SecurityEvent,
  fields: Record<string, unknown> = {},
): void {
  logger.warn({ ...fields, security: true, event }, `security event: ${event}`);
}
