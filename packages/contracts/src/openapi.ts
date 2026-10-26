import { z } from 'zod';
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiResponseObject,
} from 'zod-openapi';
import { ERROR_REGISTRY, type ErrorCode } from './errors.js';
import { OPERATIONS, type OperationContract } from './operations.js';
import { problemSchema } from './schemas/problem.js';

// Generates the OpenAPI document from the operation contracts and the error registry
// (ADR-0008, research R12). `npm run contract:generate` writes it to
// packages/contracts/openapi/openapi.json, which is committed; CI fails on any drift.

/** The correlation id format the API accepts and echoes (research R10). */
export const REQUEST_ID_PATTERN = '^[A-Za-z0-9._-]{8,36}$';

const requestIdHeader = z
  .string()
  .regex(new RegExp(REQUEST_ID_PATTERN))
  .meta({
    header: {
      id: 'XRequestId',
      description:
        'Correlation id. If the client sends a value matching ^[A-Za-z0-9._-]{8,36}$ (room ' +
        'for a UUID), it is echoed back; otherwise a generated UUIDv7 is returned.',
    },
  });

const responseHeaders = z.object({ 'X-Request-Id': requestIdHeader });

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

const UNSAFE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

/** Codes any operation can return: validation, size and origin for bodies, and failure. */
function errorCodes(operation: OperationContract): ErrorCode[] {
  const codes: ErrorCode[] = ['VALIDATION_FAILED', 'INTERNAL_ERROR'];
  if (UNSAFE_METHODS.has(operation.method)) codes.push('CSRF_REJECTED', 'PAYLOAD_TOO_LARGE');
  for (const code of operation.errors ?? []) if (!codes.includes(code)) codes.push(code);
  return codes;
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function operationObject(operation: OperationContract): ZodOpenApiOperationObject {
  const responses: Record<string, ZodOpenApiResponseObject> = {};
  for (const [status, schema] of Object.entries(operation.responses)) {
    responses[status] = {
      description: SUCCESS_DESCRIPTIONS[Number(status)] ?? 'Success',
      headers: responseHeaders,
      content: { 'application/json': { schema } },
    };
  }
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of errorCodes(operation)) {
    const status = ERROR_REGISTRY[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const [status, codes] of [...byStatus].sort(([a], [b]) => a - b)) {
    responses[String(status)] = {
      description: `Problem document with code ${codes.join(' or ')}.`,
      headers: responseHeaders,
      content: { 'application/problem+json': { schema: problemSchema } },
      'x-error-codes': codes,
    };
  }
  responses['default'] = problemResponse;

  const { params, query, body } = operation.request ?? {};
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    'x-access': operation.access,
    ...(params || query ? { requestParams: { path: params, query } } : {}),
    ...(body ? { requestBody: { content: { 'application/json': { schema: body } } } } : {}),
    responses,
  } as ZodOpenApiOperationObject;
}

export function generateOpenApiDocument(): ReturnType<typeof createDocument> {
  const paths: Record<string, Record<string, ZodOpenApiOperationObject>> = {};
  for (const operation of Object.values(OPERATIONS) as OperationContract[]) {
    const path = toOpenApiPath(operation.path);
    paths[path] = { ...paths[path], [operation.method]: operationObject(operation) };
  }
  return createDocument({
    openapi: '3.1.0',
    info: { title: 'Vendor & Purchase Order Management API', version: '0.1.0' },
    servers: [
      {
        url: '/api',
        description:
          'Same-origin prefix. nginx (and the Vite dev proxy) strips /api before forwarding.',
      },
    ],
    paths,
  });
}

/** The committed form: two-space JSON with a trailing newline. */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
}
