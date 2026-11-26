import {
  isErrorCode,
  isFieldCode,
  oneOf,
  NOT_ORDER_OWNER_DETAIL,
  ORDER_CANCEL_FORBIDDEN_DETAIL,
  ORDER_DECISION_FORBIDDEN_DETAIL,
  ORDER_LOCKED_MESSAGES,
  ORDER_OWNER_INACTIVE_DETAIL,
  ORDER_PENDING_APPROVAL_DETAIL,
  ORDER_RECEIPT_FORBIDDEN_DETAIL,
  ORDER_WRITE_FORBIDDEN_DETAIL,
  RECEIPT_NOTHING_RECORDED,
  exceedingLineSentence,
  SELF_APPROVAL_DETAIL,
  SELF_APPROVAL_DETAILS,
  type LockedOrderStatus,
  type OrderAction,
  type OrderStatus,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PUBLIC_REVOKE_REASONS,
  type ErrorCode,
  type ExceedingLine,
  type FieldCode,
  type PublicRevokeReason,
  type UserRole,
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
  // A page whose link or form for a new one follows shows the message alone.
  TOKEN_EXPIRED: { message: 'This link has expired.', action: 'Request a new one.' },
  TOKEN_USED: { message: 'This link has already been used.', action: 'Log in instead.' },
  TOKEN_SUPERSEDED: { message: 'A newer link was sent. Use the latest email.' },
  INVALID_TOKEN: {
    message: "This link isn't valid. Check that you opened the whole link from the email.",
  },
  UNAUTHENTICATED: { message: 'Please log in.' },
  // Shown only if the silent refresh can't run: it normally renews the login and retries.
  ACCESS_TOKEN_EXPIRED: { message: 'Your login has expired. Please log in again.' },
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
  ACCOUNT_LOCKED: {
    message: 'This account is locked after too many failed login attempts.',
    action: 'Try again in a few minutes.',
  },
  RATE_LIMITED: {
    message: "You've made too many requests in a short time.",
    action: 'Wait a few minutes, then try again.',
  },
  // Slice 2 (specs/003-vendors/contracts/errors.md). The form adds a link to the
  // existing vendor, from the problem's existingVendor.
  DUPLICATE_VENDOR_NAME: { message: 'A vendor with this name already exists.' },
  // Neutral: vendors use it now, orders from slice 4.
  INVALID_STATE_TRANSITION: {
    message: 'Its status has already changed.',
    action: 'Reload to see the current status.',
  },
  VENDOR_INACTIVE: {
    message: 'This vendor is deactivated.',
    action: 'Reactivate it or choose another vendor.',
  },
  // Slice 3 (specs/004-draft-orders/contracts/errors.md).
  IDEMPOTENCY_KEY_REUSED: {
    message: 'This request was already used for a different order.',
    action: 'Start a new order.',
  },
  // Slice 4 (specs/005-submit-approve/contracts/errors.md): the API's details, word for
  // word. ORDER_LOCKED's words follow the order's status (messageForProblem).
  NOT_ORDER_OWNER: { message: NOT_ORDER_OWNER_DETAIL },
  SELF_APPROVAL: { message: SELF_APPROVAL_DETAIL },
  ORDER_LOCKED: { message: "This order can't be changed any more." },
  ORDER_PENDING_APPROVAL: { message: ORDER_PENDING_APPROVAL_DETAIL },
  ORDER_OWNER_INACTIVE: { message: ORDER_OWNER_INACTIVE_DETAIL },
  // Slice 6 (specs/007-goods-receipt/contracts/errors.md). ORDER_NOT_RECEIVABLE names the
  // order's status and RECEIPT_EXCEEDS_OUTSTANDING each offending line (messageForProblem).
  ORDER_NOT_RECEIVABLE: {
    message: "This order can't receive goods.",
    action: 'Reload the order to see its status.',
  },
  RECEIPT_EXCEEDS_OUTSTANDING: {
    message: RECEIPT_NOTHING_RECORDED,
    action: 'Reload the order to see what is outstanding.',
  },
  ORDER_FULLY_RECEIVED: {
    message: "This order has been fully received, so it can't be cancelled.",
  },
} as const satisfies Record<ErrorCode, ErrorMessage>;

/** An order's status in "This order can't receive goods: it is …" (an approved one can). */
const NOT_RECEIVABLE_STATUS_WORDS = {
  DRAFT: 'a draft',
  PENDING_APPROVAL: 'pending approval',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
} as const satisfies Partial<Record<OrderStatus, string>>;

function isNotReceivableStatus(
  status: OrderStatus,
): status is keyof typeof NOT_RECEIVABLE_STATUS_WORDS {
  return Object.hasOwn(NOT_RECEIVABLE_STATUS_WORDS, status);
}

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

/** A field error of a problem: the field's path and its field code. */
export interface FieldErrorLike {
  path: string;
  code: string;
}

/** The fields of a problem document a screen needs. */
export interface ProblemLike {
  code: string;
  /** The fields refused, on VALIDATION_FAILED. */
  details?: readonly FieldErrorLike[] | undefined;
  correlationId?: string | undefined;
  /** Why a session was revoked, on SESSION_REVOKED only. */
  reason?: string | undefined;
  /** The vendor a name clashed with, on DUPLICATE_VENDOR_NAME only. */
  existingVendor?: { id: string; name: string } | undefined;
  /** The order's status and the refused action, on the order state codes. */
  orderState?: { status: OrderStatus; action?: OrderAction | undefined } | undefined;
  /** The lines a receipt would over-receive, on RECEIPT_EXCEEDS_OUTSTANDING only. */
  lines?: readonly ExceedingLine[] | undefined;
}

/** The message for a code; an unknown code (a newer server) gets the internal-error one. */
export function messageFor(code: string): ErrorMessage {
  return isErrorCode(code) ? errorMessages[code] : errorMessages.INTERNAL_ERROR;
}

function isPublicRevokeReason(value: unknown): value is PublicRevokeReason {
  return oneOf(PUBLIC_REVOKE_REASONS, value);
}

/** A status ORDER_LOCKED has its own sentence for (approved, rejected, cancelled). */
function isLockedStatus(status: OrderStatus): status is LockedOrderStatus {
  return Object.hasOwn(ORDER_LOCKED_MESSAGES, status);
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
  if (problem.code === 'ORDER_LOCKED') {
    const status = problem.orderState?.status;
    if (status !== undefined && isLockedStatus(status)) {
      return { message: ORDER_LOCKED_MESSAGES[status] };
    }
  }
  if (problem.code === 'ORDER_NOT_RECEIVABLE') {
    const status = problem.orderState?.status;
    if (status !== undefined && isNotReceivableStatus(status)) {
      return {
        message: `This order can't receive goods: it is ${NOT_RECEIVABLE_STATUS_WORDS[status]}.`,
      };
    }
  }
  if (problem.code === 'RECEIPT_EXCEEDS_OUTSTANDING' && problem.lines?.length) {
    return {
      message: errorMessages.RECEIPT_EXCEEDS_OUTSTANDING.message,
      action: problem.lines.map(exceedingLineSentence).join(' '),
    };
  }
  return messageFor(problem.code);
}

/**
 * The message for a failed order action: a route-level FORBIDDEN says why, in the same
 * words the API puts in the problem's detail, by the signed-in role and the kind of action
 * (ADR-0004, 2026-11-12 and 2026-11-17). The screen branches on the code and the roles,
 * never on the detail text.
 */
export function messageForOrderAction(
  problem: ProblemLike,
  {
    roles,
    action,
  }: { roles: readonly UserRole[]; action: 'write' | 'decision' | 'cancel' | 'receipt' },
): ErrorMessage {
  if (problem.code === 'SELF_APPROVAL' && action === 'cancel') {
    return { message: SELF_APPROVAL_DETAILS.CANCEL };
  }
  if (problem.code === 'FORBIDDEN') {
    const details: Partial<Record<UserRole, string>> =
      action === 'write'
        ? ORDER_WRITE_FORBIDDEN_DETAIL
        : action === 'receipt'
          ? ORDER_RECEIPT_FORBIDDEN_DETAIL
          : action === 'cancel'
            ? ORDER_CANCEL_FORBIDDEN_DETAIL
            : ORDER_DECISION_FORBIDDEN_DETAIL;
    const message = roles.map((role) => details[role]).find((d) => d !== undefined);
    if (message !== undefined) return { message };
  }
  return messageForProblem(problem);
}

export function isRetryable(code: string): boolean {
  return oneOf(RETRYABLE_CODES, code);
}

/** A required reason left blank, or refused by the server as missing or too short. */
export const REASON_REQUIRED_MESSAGE = 'Enter a reason.';

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
  LINE_NOT_FOUND: 'This line is no longer on the order. Reload it.',
  DUPLICATE_LINE_ID: 'This line appears twice. Reload the order.',
  READ_ONLY_FIELD: "This is calculated by the system and can't be set.",
  DATE_IN_FUTURE: "Enter today's date or an earlier one.",
  DATE_BEFORE_APPROVAL: "Enter a date on or after the order's approval.",
} as const satisfies Record<FieldCode, string>;

/** DATE_BEFORE_APPROVAL with the approval date, as the receipt form knows it. */
export function dateBeforeApprovalMessage(approvalDate: string): string {
  return `Enter a date on or after the order's approval (${approvalDate}).`;
}

/** The password rule, as account pages state it next to a new-password field. */
export const PASSWORD_RULE = `Use ${String(PASSWORD_MIN_LENGTH)} to ${String(PASSWORD_MAX_LENGTH)} characters. Common passwords are refused.`;

const SECONDS_PER_MINUTE = 60;

/** Codes whose Retry-After says how long to wait (ADR-0017). */
const WAIT_CODES: readonly string[] = [
  'ACCOUNT_LOCKED',
  'RATE_LIMITED',
] satisfies readonly ErrorCode[];

/** The next step of a validation failure whose field errors are all said at form level. */
const CORRECT_THEM = 'Correct them and try again.';

/** A failed call as a page has it: the problem, and the wait from Retry-After if any. */
export interface FailureLike {
  problem: ProblemLike;
  retryAfterSeconds?: number | undefined;
}

/** The fields a form shows, for saying a validation failure at form level. */
export interface FormFields {
  /** Paths whose errors the page shows next to their own field. */
  highlighted?: readonly string[];
  /** Labels for paths said at form level, such as { 'body.email': 'Email' }. */
  labels?: Readonly<Record<string, string>>;
  /** The screen's own words for a problem, by its code (e.g. cancel's SELF_APPROVAL). */
  messageFor?: ((problem: ProblemLike) => ErrorMessage) | undefined;
  /** The screen's own words for one field error, when it knows more (e.g. a date). */
  fieldText?: ((detail: { path: string; code: string }) => string | undefined) | undefined;
}

/** What a field error says; a code this build doesn't know reads as not valid. */
export function fieldMessageFor(code: string): string {
  return isFieldCode(code) ? fieldMessages[code] : fieldMessages.INVALID_FORMAT;
}

/**
 * What a failure tells the user, as a message and a next step. A lockout or rate limit
 * with Retry-After gives the wait in whole minutes, rounded up (ADR-0017). A validation
 * failure says at form level each field error the page doesn't show by its field, and
 * mentions highlighted fields only when the page highlights one.
 */
export function describeFailure(failure: FailureLike, form: FormFields = {}): ErrorMessage {
  const { problem, retryAfterSeconds } = failure;
  const { message, action } = (form.messageFor ?? messageForProblem)(problem);
  if (retryAfterSeconds !== undefined && WAIT_CODES.includes(problem.code)) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / SECONDS_PER_MINUTE));
    return {
      message,
      action: `Try again in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`,
    };
  }
  if (problem.code !== 'VALIDATION_FAILED') return action ? { message, action } : { message };
  const highlighted = form.highlighted ?? [];
  const details = problem.details ?? [];
  const unshown = details.filter((detail) => !highlighted.includes(detail.path));
  const said = unshown.map((detail) => {
    const label = form.labels?.[detail.path];
    const text = form.fieldText?.(detail) ?? fieldMessageFor(detail.code);
    return label ? `${label}: ${text}` : text;
  });
  const anyHighlighted = details.length > unshown.length;
  return {
    message: [message, ...said].join(' '),
    action: anyHighlighted ? errorMessages.VALIDATION_FAILED.action : CORRECT_THEM,
  };
}

/** A failure's message and next step as one sentence pair. */
export function sentenceFor(problem: ProblemLike, retryAfterSeconds?: number): string {
  return sentenceOf(describeFailure({ problem, retryAfterSeconds }));
}

/** A message and its next step as one sentence pair. */
export function sentenceOf({ message, action }: ErrorMessage): string {
  return action ? `${message} ${action}` : message;
}
