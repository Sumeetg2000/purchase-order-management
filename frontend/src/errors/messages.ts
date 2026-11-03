import {
  isErrorCode,
  PUBLIC_REVOKE_REASONS,
  type ErrorCode,
  type PublicRevokeReason,
} from '@po/contracts';

// What the user is told for each registry code (contracts/ui-components.md). Keyed by the
// registry, so a code a slice adds without a message fails the typecheck and a test.

export interface ErrorMessage {
  message: string;
  /** What the user can do next. */
  action?: string;
}

export const errorMessages = {
  VALIDATION_FAILED: {
    message: 'Some of the details are not valid.',
    action: 'Check the highlighted fields and try again.',
  },
  CSRF_REJECTED: {
    message: 'The request was refused to keep your account safe.',
    action: 'Reload the page and try again.',
  },
  NOT_FOUND: {
    message: "We couldn't find what you were looking for.",
    action: 'Check the address, or go back to the home page.',
  },
  PAYLOAD_TOO_LARGE: {
    message: 'That was too much to send at once.',
    action: 'Send less at a time.',
  },
  INTERNAL_ERROR: {
    message: 'Something went wrong on our side.',
    action: 'Try again later. If it keeps happening, quote the request ID.',
  },
  SERVICE_UNAVAILABLE: {
    message: 'The service is temporarily unavailable.',
    action: 'Wait a moment, then retry.',
  },
  CONCURRENCY_RETRY_EXHAUSTED: {
    message: 'The system is busy with other changes right now.',
    action: 'Wait a moment, then retry.',
  },

  // Slice 1: accounts and sessions (contracts/errors.md).
  SIGNUP_DOMAIN_NOT_ALLOWED: { message: 'Use your company email address to sign up.' },
  TOKEN_EXPIRED: { message: 'This link has expired. Request a new one.' },
  TOKEN_USED: { message: 'This link has already been used.', action: 'Log in instead.' },
  TOKEN_SUPERSEDED: { message: 'A newer link was sent. Use the latest email.' },
  INVALID_TOKEN: {
    message: "This link isn't valid. Check that you opened the whole link from the email.",
  },
  UNAUTHENTICATED: { message: 'Please log in.' },
  // Never shown: the app refreshes the session and retries.
  ACCESS_TOKEN_EXPIRED: { message: 'Please log in.' },
  SESSION_EXPIRED: { message: 'Your session has expired. Please log in again.' },
  SESSION_REVOKED: { message: "You've been logged out. Please log in again." },
  PASSWORD_NOT_SET: {
    message: 'No password is set for this account.',
    action: 'Use your set-password link, or reset your password.',
  },
  INCORRECT_PASSWORD: { message: 'Incorrect password.' },
  ACCOUNT_NOT_VERIFIED: {
    message: 'Verify your email before logging in.',
    action: 'Send a new verification email if you need one.',
  },
  ACCOUNT_DEACTIVATED: {
    message: 'This account has been deactivated.',
    action: 'Contact an admin.',
  },
  FORBIDDEN: { message: "You don't have permission to do this." },
  // Never shown: the app routes to the Access pending screen.
  NO_ROLE_ASSIGNED: {
    message: "Your account doesn't have a role yet.",
    action: 'Ask an administrator for access.',
  },
  ACCOUNT_NOT_FOUND: { message: 'No account found with this email.', action: 'Sign up instead.' },
  EMAIL_IN_USE: {
    message: 'An account with this email already exists.',
    action: 'Log in, or reset your password.',
  },
  ACCOUNT_ALREADY_VERIFIED: { message: 'This account is already verified.', action: 'Log in.' },
  VERSION_CONFLICT: {
    message: 'Someone else changed this.',
    action: 'Reload to see the latest version.',
  },
  SELF_MODIFICATION: { message: "You can't change your own account here." },
  ADMIN_NOT_MODIFIABLE: { message: 'Admin accounts are managed by the operator.' },
  USER_UNVERIFIED: {
    message: "This user hasn't verified their email.",
    action: 'Send them a password reset instead.',
  },
  ACCESS_REQUEST_NOT_OPEN: {
    message: 'This request has already been handled.',
    action: 'Reload to see its status.',
  },
  ACCOUNT_LOCKED: { message: 'Too many failed attempts.', action: 'Try again in a few minutes.' },
  RATE_LIMITED: { message: 'Too many attempts.', action: 'Try again in a few minutes.' },
} as const satisfies Record<ErrorCode, ErrorMessage>;

/** The words for each public revoke reason, in "You were logged out because …". */
export const revokeReasonText = {
  PASSWORD_CHANGED: 'your password was changed',
  PASSWORD_RESET: 'your password was reset',
  ROLES_CHANGED: 'your roles were changed',
} as const satisfies Record<PublicRevokeReason, string>;

/** Temporary failures, where trying the same request again can succeed. */
export const RETRYABLE_CODES = [
  'SERVICE_UNAVAILABLE',
  'CONCURRENCY_RETRY_EXHAUSTED',
] as const satisfies readonly ErrorCode[];

/** The fields of a problem document a screen needs. */
export interface ProblemLike {
  code: string;
  correlationId?: string | undefined;
  /** Why a session was revoked, on SESSION_REVOKED only. */
  reason?: string | undefined;
}

/** The message for a code; an unknown code (a newer server) gets the internal-error one. */
export function messageFor(code: string): ErrorMessage {
  return isErrorCode(code) ? errorMessages[code] : errorMessages.INTERNAL_ERROR;
}

function isPublicRevokeReason(value: unknown): value is PublicRevokeReason {
  return (PUBLIC_REVOKE_REASONS as readonly unknown[]).includes(value);
}

/**
 * The message for a problem: as messageFor, except that SESSION_REVOKED with a public
 * reason says why the user was logged out (ADR-0018, amended 2026-11-03).
 */
export function messageForProblem(problem: ProblemLike): ErrorMessage {
  if (problem.code === 'SESSION_REVOKED' && isPublicRevokeReason(problem.reason)) {
    return {
      message: `You were logged out because ${revokeReasonText[problem.reason]}. Please log in again.`,
    };
  }
  return messageFor(problem.code);
}

export function isRetryable(code: string): boolean {
  return (RETRYABLE_CODES as readonly string[]).includes(code);
}
