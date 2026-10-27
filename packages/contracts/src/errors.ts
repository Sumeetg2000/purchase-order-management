// The single error code registry (ADR-0007). The API, the OpenAPI generator and the web
// app's message map all read it. Each slice adds the codes it uses, never earlier.

export interface ErrorDefinition {
  status: number;
  title: string;
  /** Whether the problem may carry `details[{ path, code }]`. */
  fieldDetails: boolean;
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
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_REGISTRY;

export const ERROR_CODES = Object.keys(ERROR_REGISTRY) as readonly ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_REGISTRY, value);
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
] as const;

export type FieldCode = (typeof FIELD_CODES)[number];

export interface FieldError {
  /** Dot path into the request, e.g. `body.lines.3.quantity` or `header.content-type`. */
  path: string;
  code: FieldCode;
}
