import {
  carriesRevokeReason,
  ERROR_REGISTRY,
  isErrorCode,
  type ErrorCode,
  type FieldError,
} from './errors.js';
import type { PublicRevokeReason } from './sessions.js';

export class UnregisteredErrorCodeError extends TypeError {
  override readonly name = 'UnregisteredErrorCodeError';
}

export interface AppErrorOptions {
  /** Field-level details; only for codes whose registry entry allows them. */
  details?: readonly FieldError[];
  /** A safe, human-readable explanation. Never internal detail. */
  detail?: string;
  /** Why a session was revoked; only for codes whose registry entry allows a reason. */
  reason?: PublicRevokeReason;
  cause?: unknown;
}

/** The one error type the API throws on purpose. Its status comes from the registry. */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: readonly FieldError[] | undefined;
  readonly detail: string | undefined;
  readonly reason: PublicRevokeReason | undefined;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    if (!isErrorCode(code)) {
      throw new UnregisteredErrorCodeError(`Error code ${String(code)} is not in the registry`);
    }
    if (options.reason !== undefined && !carriesRevokeReason(code)) {
      throw new TypeError(`Error code ${code} can't carry a revoke reason`);
    }
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = ERROR_REGISTRY[code].status;
    this.details = options.details;
    this.detail = options.detail;
    this.reason = options.reason;
  }
}
