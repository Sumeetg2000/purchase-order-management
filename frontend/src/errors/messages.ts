import { isErrorCode, type ErrorCode } from '@po/contracts';

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
} as const satisfies Record<ErrorCode, ErrorMessage>;

/** Temporary failures, where trying the same request again can succeed. */
export const RETRYABLE_CODES = [
  'SERVICE_UNAVAILABLE',
  'CONCURRENCY_RETRY_EXHAUSTED',
] as const satisfies readonly ErrorCode[];

/** The fields of a problem document a screen needs. */
export interface ProblemLike {
  code: string;
  correlationId?: string | undefined;
}

/** The message for a code; an unknown code (a newer server) gets the internal-error one. */
export function messageFor(code: string): ErrorMessage {
  return isErrorCode(code) ? errorMessages[code] : errorMessages.INTERNAL_ERROR;
}

export function isRetryable(code: string): boolean {
  return (RETRYABLE_CODES as readonly string[]).includes(code);
}
