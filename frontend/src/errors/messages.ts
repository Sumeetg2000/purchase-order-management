import {
  isErrorCode,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PUBLIC_REVOKE_REASONS,
  type ErrorCode,
  type FieldCode,
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
  USER_DEACTIVATED: {
    message: 'This user is deactivated.',
    action: 'Reactivate them first.',
  },
  ACCESS_REQUEST_NOT_OPEN: {
    message: 'This request has already been handled.',
    action: 'Reload to see its status.',
  },
  ACCOUNT_LOCKED: { message: 'Too many failed attempts.', action: 'Try again in a few minutes.' },
  RATE_LIMITED: { message: 'Too many attempts.', action: 'Try again in a few minutes.' },
  // Slice 2 (specs/003-vendors/contracts/errors.md). The form adds a link to the
  // existing vendor, from the problem's existingVendor.
  DUPLICATE_VENDOR_NAME: { message: 'A vendor with this name already exists.' },
  INVALID_STATE_TRANSITION: {
    message: "This vendor's status has already changed.",
    action: 'Reload to see it.',
  },
  VENDOR_INACTIVE: {
    message: 'This vendor is deactivated.',
    action: 'Reactivate it or choose another vendor.',
  },
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
  /** The vendor a name clashed with, on DUPLICATE_VENDOR_NAME only. */
  existingVendor?: { id: string; name: string } | undefined;
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

/** What a field error says, by field code (ADR-0007), next to the field. */
export const fieldMessages = {
  MALFORMED_JSON: 'The request could not be read.',
  UNSUPPORTED_MEDIA_TYPE: 'The request could not be read.',
  REQUIRED: 'This is required.',
  UNKNOWN_FIELD: 'This field is not accepted.',
  INVALID_FORMAT: 'This is not in the expected format.',
  TOO_SHORT: 'This is too short.',
  TOO_LONG: 'This is too long.',
  OUT_OF_RANGE: 'This is out of range.',
  VERSION_REQUIRED: 'Reload and try again.',
  INVALID_ROLE_SET: 'Choose Buyer, Approver, or Buyer and Approver.',
  PASSWORD_TOO_SHORT: `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`,
  PASSWORD_TOO_LONG: `Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`,
  PASSWORD_TOO_COMMON: 'This password is too common. Choose another.',
  INCORRECT_PASSWORD: 'Incorrect password.',
  PASSWORD_UNCHANGED: 'Your new password must be different from your current one.',
  VENDOR_NOT_FOUND: 'This vendor no longer exists.',
} as const satisfies Record<FieldCode, string>;

/** The password rule, as account pages state it next to a new-password field. */
export const PASSWORD_RULE = `Use ${String(PASSWORD_MIN_LENGTH)} to ${String(PASSWORD_MAX_LENGTH)} characters. Common passwords are refused.`;

const SECONDS_PER_MINUTE = 60;

/**
 * A problem's message and next step as one sentence pair. For a lockout or rate limit
 * with Retry-After, the wait is given in whole minutes, rounded up (ADR-0017).
 */
export function sentenceFor(problem: ProblemLike, retryAfterSeconds?: number): string {
  const { message, action } = messageForProblem(problem);
  if (
    retryAfterSeconds !== undefined &&
    (problem.code === 'ACCOUNT_LOCKED' || problem.code === 'RATE_LIMITED')
  ) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / SECONDS_PER_MINUTE));
    return `${message} Try again in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`;
  }
  return action ? `${message} ${action}` : message;
}
