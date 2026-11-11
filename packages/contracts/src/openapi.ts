import { z } from 'zod';
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiResponseObject,
} from 'zod-openapi';
import { clashMemberOf, ERROR_REGISTRY, type ClashMember, type ErrorCode } from './errors.js';
import { ETAG_PATTERN } from './etag.js';
import {
  accessProblem,
  API_PATH_PREFIX,
  OPERATIONS,
  type Access,
  type OperationContract,
} from './operations.js';
import { REQUEST_ID_PATTERN } from './request-id.js';
import { problemSchema } from './schemas/problem.js';
import { ACCESS_COOKIE, CSRF_HEADER, REFRESH_COOKIE, requiresCsrf } from './session-cookies.js';

// Generates the OpenAPI document from the operation contracts and the error registry
// (ADR-0008, research R12). `npm run contract:generate` writes it to
// packages/contracts/openapi/openapi.json, which is committed; CI fails on any drift.

const requestIdHeader = z
  .string()
  .regex(REQUEST_ID_PATTERN)
  .meta({
    header: {
      id: 'XRequestId',
      description:
        `Correlation id. If the client sends a value matching ${REQUEST_ID_PATTERN.source} ` +
        '(room for a UUID), it is echoed back; otherwise a generated UUIDv7 is returned.',
    },
  });

const responseHeaders = z.object({ 'X-Request-Id': requestIdHeader });

const cookieHeaders = responseHeaders.extend({
  'Set-Cookie': z.string().meta({
    description: 'The session cookies: po_access, po_refresh and po_csrf (ADR-0017).',
  }),
});

const etagHeaders = responseHeaders.extend({
  ETag: z
    .string()
    .regex(ETAG_PATTERN)
    .meta({ description: "The resource's version; send it back in If-Match to update it." }),
});

const locationHeader = {
  Location: z.string().meta({ description: 'The path of the created resource.' }),
};

const maybeCookieHeaders = responseHeaders.extend({
  'Set-Cookie': z.string().optional().meta({
    description: 'When the session ended is the calling one: its cookies, cleared (ADR-0017).',
  }),
});

const retryHeaders = responseHeaders.extend({
  'Retry-After': z
    .string()
    .regex(/^[0-9]+$/)
    .meta({ description: 'Seconds to wait.' }),
});

const problemResponse = {
  id: 'Problem',
  description: 'Any error, in RFC 9457 format.',
  headers: responseHeaders,
  content: { 'application/problem+json': { schema: problemSchema } },
};

const SUCCESS_DESCRIPTIONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
};

/** The cookies and header that authenticate a request (ADR-0017). */
const SECURITY_SCHEMES = {
  accessCookie: { type: 'apiKey', in: 'cookie', name: ACCESS_COOKIE },
  refreshCookie: { type: 'apiKey', in: 'cookie', name: REFRESH_COOKIE },
  csrfHeader: { type: 'apiKey', in: 'header', name: CSRF_HEADER },
} as const;
type SecurityScheme = keyof typeof SECURITY_SCHEMES;

/** The credential each access level needs; public needs none. */
const CREDENTIAL: Readonly<Record<Access, SecurityScheme | undefined>> = {
  public: undefined,
  refresh: 'refreshCookie',
  user: 'accessCookie',
  'no-role': 'accessCookie',
  admin: 'accessCookie',
  role: 'accessCookie',
};

/** Security requirements: the credential, plus the CSRF header on unsafe methods. */
function security(operation: OperationContract): Record<string, string[]>[] | undefined {
  const credential = CREDENTIAL[operation.access];
  if (!credential) return undefined;
  const requirement: Record<string, string[]> = { [credential]: [] };
  if (requiresCsrf(operation.method)) requirement['csrfHeader'] = [];
  return [requirement];
}

const ifMatchHeader = z.strictObject({
  'If-Match': z
    .string()
    .regex(ETAG_PATTERN)
    .meta({ description: 'The ETag from the last read; a missing or stale one is refused.' }),
});

/** The codes the authorize step answers for any logged-in caller (research R1). */
const SESSION_CODES = [
  'UNAUTHENTICATED',
  'ACCESS_TOKEN_EXPIRED',
  'ACCOUNT_DEACTIVATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
] as const satisfies readonly ErrorCode[];

/** The codes the authorize step answers for each access level. */
const ACCESS_CODES: Readonly<Record<Access, readonly ErrorCode[]>> = {
  public: [],
  refresh: ['UNAUTHENTICATED', 'SESSION_EXPIRED'],
  // Every request checks its session (ADR-0017, amended 2026-11-03).
  user: SESSION_CODES,
  'no-role': [...SESSION_CODES, 'FORBIDDEN'],
  admin: [...SESSION_CODES, 'NO_ROLE_ASSIGNED', 'FORBIDDEN'],
  role: [...SESSION_CODES, 'NO_ROLE_ASSIGNED', 'FORBIDDEN'],
};

/** Codes whose responses say when to try again (lockout, rate limits). */
const RETRY_AFTER_CODES: ReadonlySet<ErrorCode> = new Set(['ACCOUNT_LOCKED', 'RATE_LIMITED']);

/**
 * Codes any operation can return: validation, size and origin for bodies, its access
 * level's, and failure; then its own.
 */
function errorCodes(operation: OperationContract): ErrorCode[] {
  const codes: ErrorCode[] = ['VALIDATION_FAILED', 'INTERNAL_ERROR'];
  if (requiresCsrf(operation.method)) codes.push('CSRF_REJECTED', 'PAYLOAD_TOO_LARGE');
  for (const code of ACCESS_CODES[operation.access]) if (!codes.includes(code)) codes.push(code);
  for (const code of operation.errors ?? []) if (!codes.includes(code)) codes.push(code);
  return codes;
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** The headers of a success response; a 201 also says where the new resource is. */
function successHeaders(operation: OperationContract, status: number) {
  const headers =
    operation.setsCookies === 'sometimes'
      ? maybeCookieHeaders
      : operation.setsCookies
        ? cookieHeaders
        : operation.etag
          ? etagHeaders
          : responseHeaders;
  return status === 201 ? headers.extend(locationHeader) : headers;
}

/** The clash members an error response's codes may carry, by code (ADR-0007). */
function problemMembers(codes: readonly ErrorCode[]): Record<string, ClashMember[]> | undefined {
  const members: Record<string, ClashMember[]> = {};
  for (const code of codes) {
    const member = clashMemberOf(code);
    if (member) members[code] = [member];
  }
  return Object.keys(members).length > 0 ? members : undefined;
}

function operationObject(operation: OperationContract): ZodOpenApiOperationObject {
  const problem = accessProblem(operation);
  if (problem) throw new TypeError(`Operation ${operation.operationId} ${problem}`);
  const responses: Record<string, ZodOpenApiResponseObject> = {};
  for (const [status, schema] of Object.entries(operation.responses)) {
    responses[status] = {
      description: SUCCESS_DESCRIPTIONS[Number(status)] ?? 'Success',
      headers: successHeaders(operation, Number(status)),
      // A void response (204, or a 202 that only acknowledges) has no body, so no content
      // type either.
      ...(schema._zod.def.type === 'void' ? {} : { content: { 'application/json': { schema } } }),
    };
  }
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of errorCodes(operation)) {
    const status = ERROR_REGISTRY[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const [status, codes] of [...byStatus].sort(([a], [b]) => a - b)) {
    const members = problemMembers(codes);
    responses[String(status)] = {
      description: `Problem document with code ${codes.join(' or ')}.`,
      headers: codes.some((code) => RETRY_AFTER_CODES.has(code)) ? retryHeaders : responseHeaders,
      content: { 'application/problem+json': { schema: problemSchema } },
      'x-error-codes': codes,
      ...(members ? { 'x-problem-members': members } : {}),
    };
  }
  responses['default'] = problemResponse;

  const { params, query, body } = operation.request ?? {};
  const header = operation.ifMatch === 'required' ? ifMatchHeader : undefined;
  const requirements = security(operation);
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    'x-access': operation.access,
    ...(operation.roles ? { 'x-roles': operation.roles } : {}),
    ...(requirements ? { security: requirements } : {}),
    ...(params || query || header
      ? {
          requestParams: {
            ...(params ? { path: params } : {}),
            ...(query ? { query } : {}),
            ...(header ? { header } : {}),
          },
        }
      : {}),
    ...(body ? { requestBody: { content: { 'application/json': { schema: body } } } } : {}),
    responses,
  } as ZodOpenApiOperationObject;
}

/** The document for the API's operations. */
export function generateOpenApiDocument(): ReturnType<typeof createDocument> {
  return buildOpenApiDocument(Object.values(OPERATIONS));
}

/** The document for any set of operations (the generator's own tests use made-up ones). */
export function buildOpenApiDocument(
  operations: readonly OperationContract[],
): ReturnType<typeof createDocument> {
  const paths: Record<string, Record<string, ZodOpenApiOperationObject>> = {};
  for (const operation of operations) {
    const path = toOpenApiPath(operation.path);
    paths[path] = { ...paths[path], [operation.method]: operationObject(operation) };
  }
  return createDocument({
    openapi: '3.1.0',
    info: { title: 'Vendor & Purchase Order Management API', version: '0.1.0' },
    servers: [
      {
        url: API_PATH_PREFIX,
        description:
          'Same-origin prefix. nginx (and the Vite dev proxy) strips /api before forwarding.',
      },
    ],
    paths,
    components: { securitySchemes: SECURITY_SCHEMES },
  });
}

/** The committed form: two-space JSON with a trailing newline. */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
}
