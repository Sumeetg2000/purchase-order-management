import type { Logger } from 'pino';

// Security events (ADR-0017, research R18): structured log entries marked security: true,
// separate from the business audit. Each carries the request id through the request's
// logger, and only allow-listed fields: never a token, password, phone number or
// recipient address, whatever a caller passes.

export const SECURITY_EVENTS = [
  // Mail: a send failed, or shutdown stopped waiting for one (outcome unknown).
  'mail_send_failed',
  'mail_send_abandoned',
  // Accounts and sessions (slice 1).
  'signup',
  'email_verified',
  'login_succeeded',
  'login_failed',
  'account_locked',
  'logout',
  'logout_all',
  'refresh_reuse_detected',
  'session_revoked',
  'password_reset_requested',
  'password_reset_completed',
  'password_changed',
  'password_change_failed',
] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

/** Events that report something going wrong; the rest are ordinary account activity. */
const WARNING_EVENTS: ReadonlySet<SecurityEvent> = new Set([
  'mail_send_failed',
  'mail_send_abandoned',
  'login_failed',
  'account_locked',
  'refresh_reuse_detected',
  'password_change_failed',
]);

/** The only fields a security line may carry. */
export const SECURITY_FIELDS = [
  'userId',
  'sessionId',
  'ip',
  'userAgent',
  /** Why: a login failure's cause, or a session's revoke reason. */
  'reason',
  /** Who revoked a session: the user, an admin, the operator or the system. */
  'by',
  // Mail failures: which template, and what identifies the error (never its text).
  'template',
  'errorName',
  'errorCode',
  'responseCode',
] as const;
export type SecurityField = (typeof SECURITY_FIELDS)[number];

export type SecurityEventFields = Partial<Record<SecurityField, unknown>>;

export function logSecurityEvent(
  logger: Logger,
  event: SecurityEvent,
  fields: SecurityEventFields = {},
): void {
  const allowed: Record<string, unknown> = {};
  for (const field of SECURITY_FIELDS) {
    if (fields[field] !== undefined) allowed[field] = fields[field];
  }
  const line = { ...allowed, security: true, event };
  const message = `security event: ${event}`;
  if (WARNING_EVENTS.has(event)) logger.warn(line, message);
  else logger.info(line, message);
}
