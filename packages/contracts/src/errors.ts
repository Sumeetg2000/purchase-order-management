// The single error code registry (ADR-0007). The API, the OpenAPI generator and the web
// app's message map all read it. Each slice adds the codes it uses, never earlier.

export interface ErrorDefinition {
  status: number;
  title: string;
  /** Whether the problem may carry `details[{ path, code }]`. */
  fieldDetails: boolean;
  /** Whether the problem may carry a public revoke `reason` (ADR-0017). */
  revokeReason?: true;
}

export const ERROR_REGISTRY = {
  VALIDATION_FAILED: { status: 400, title: 'Validation failed', fieldDetails: true },
  CSRF_REJECTED: { status: 403, title: 'Request refused', fieldDetails: false },
  NOT_FOUND: { status: 404, title: 'Not found', fieldDetails: false },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large', fieldDetails: false },
  INTERNAL_ERROR: { status: 500, title: 'Internal error', fieldDetails: false },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable', fieldDetails: false },
  CONCURRENCY_RETRY_EXHAUSTED: {
    status: 503,
    title: 'Too much concurrent activity',
    fieldDetails: false,
  },

  // Slice 1: accounts and sessions (ADR-0007, ADR-0017; contracts/errors.md).
  SIGNUP_DOMAIN_NOT_ALLOWED: {
    status: 400,
    title: 'Email domain not allowed',
    fieldDetails: false,
  },
  TOKEN_EXPIRED: { status: 400, title: 'Link expired', fieldDetails: false },
  TOKEN_USED: { status: 400, title: 'Link already used', fieldDetails: false },
  TOKEN_SUPERSEDED: { status: 400, title: 'Link replaced by a newer one', fieldDetails: false },
  INVALID_TOKEN: { status: 400, title: 'Invalid link', fieldDetails: false },
  UNAUTHENTICATED: { status: 401, title: 'Not logged in', fieldDetails: false },
  ACCESS_TOKEN_EXPIRED: { status: 401, title: 'Access token expired', fieldDetails: false },
  SESSION_EXPIRED: { status: 401, title: 'Session expired', fieldDetails: false },
  SESSION_REVOKED: {
    status: 401,
    title: 'Session revoked',
    fieldDetails: false,
    revokeReason: true,
  },
  PASSWORD_NOT_SET: { status: 401, title: 'No password set', fieldDetails: false },
  INCORRECT_PASSWORD: { status: 401, title: 'Incorrect password', fieldDetails: false },
  ACCOUNT_NOT_VERIFIED: { status: 401, title: 'Email not verified', fieldDetails: false },
  ACCOUNT_DEACTIVATED: { status: 401, title: 'Account deactivated', fieldDetails: false },
  FORBIDDEN: { status: 403, title: 'Forbidden', fieldDetails: false },
  NO_ROLE_ASSIGNED: { status: 403, title: 'No role assigned', fieldDetails: false },
  ACCOUNT_NOT_FOUND: { status: 404, title: 'Account not found', fieldDetails: false },
  EMAIL_IN_USE: { status: 409, title: 'Email already in use', fieldDetails: false },
  ACCOUNT_ALREADY_VERIFIED: {
    status: 409,
    title: 'Account already verified',
    fieldDetails: false,
  },
  VERSION_CONFLICT: { status: 409, title: 'Version conflict', fieldDetails: false },
  SELF_MODIFICATION: { status: 409, title: 'Own account', fieldDetails: false },
  ADMIN_NOT_MODIFIABLE: { status: 409, title: 'Admin account', fieldDetails: false },
  USER_UNVERIFIED: { status: 409, title: 'User not verified', fieldDetails: false },
  ACCESS_REQUEST_NOT_OPEN: {
    status: 409,
    title: 'Access request not open',
    fieldDetails: false,
  },
  ACCOUNT_LOCKED: { status: 423, title: 'Account locked', fieldDetails: false },
  RATE_LIMITED: { status: 429, title: 'Too many requests', fieldDetails: false },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_REGISTRY;

export const ERROR_CODES = Object.keys(ERROR_REGISTRY) as readonly ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_REGISTRY, value);
}

/** Whether a problem with this code may carry a public revoke `reason`. */
export function carriesRevokeReason(code: ErrorCode): boolean {
  const entry: ErrorDefinition = ERROR_REGISTRY[code];
  return entry.revokeReason === true;
}

/** Codes inside `details[]` of `VALIDATION_FAILED`. */
export const FIELD_CODES = [
  'MALFORMED_JSON',
  'UNSUPPORTED_MEDIA_TYPE',
  'REQUIRED',
  'UNKNOWN_FIELD',
  'INVALID_FORMAT',
  'TOO_SHORT',
  'TOO_LONG',
  'OUT_OF_RANGE',
  // Slice 1 (contracts/errors.md)
  'VERSION_REQUIRED',
  'INVALID_ROLE_SET',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'PASSWORD_TOO_COMMON',
  'INCORRECT_PASSWORD',
] as const;

export type FieldCode = (typeof FIELD_CODES)[number];

export interface FieldError {
  /** Dot path into the request, e.g. `body.lines.3.quantity` or `header.content-type`. */
  path: string;
  code: FieldCode;
}
