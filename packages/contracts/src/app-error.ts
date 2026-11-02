import { ERROR_REGISTRY, isErrorCode, type ErrorCode, type FieldError } from './errors.js';

export class UnregisteredErrorCodeError extends TypeError {
  override readonly name = 'UnregisteredErrorCodeError';
}

export interface AppErrorOptions {
  /** Field-level details; only for codes whose registry entry allows them. */
  details?: readonly FieldError[];
  /** A safe, human-readable explanation. Never internal detail. */
  detail?: string;
  cause?: unknown;
}

/** The one error type the API throws on purpose. Its status comes from the registry. */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: readonly FieldError[] | undefined;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    if (!isErrorCode(code)) {
      throw new UnregisteredErrorCodeError(`Error code ${String(code)} is not in the registry`);
    }
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = ERROR_REGISTRY[code].status;
    this.details = options.details;
    this.detail = options.detail;
  }
}
