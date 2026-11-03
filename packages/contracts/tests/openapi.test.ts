import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCESS_LEVELS, ERROR_CODES, FIELD_CODES } from '../src/index.js';
import { z } from 'zod';
import {
  buildOpenApiDocument,
  generateOpenApiDocument,
  serializeOpenApiDocument,
} from '../src/openapi.js';

type Json = Record<string, unknown>;
const COMMITTED = new URL('../openapi/openapi.json', import.meta.url);

function at(doc: unknown, ...path: string[]): Json {
  let node = doc;
  for (const key of path) node = (node as Json | undefined)?.[key];
  if (typeof node !== 'object' || node === null) throw new Error(`no ${path.join('.')}`);
  return node as Json;
}

describe('[NFR-API-01] generated OpenAPI document', () => {
  const doc = generateOpenApiDocument() as unknown as Json;

  it('[NFR-API-01] is OpenAPI 3.1 served under the same /api prefix as the web client', () => {
    expect(doc['openapi']).toBe('3.1.0');
    expect(doc['servers']).toEqual([expect.objectContaining({ url: '/api' })]);
  });

  it('[NFR-API-01] documents the health operations and the slice 1 US1 and US2 ones, and nothing else yet', () => {
    expect(at(doc, 'paths', '/healthz', 'get')['operationId']).toBe('getHealth');
    expect(at(doc, 'paths', '/readyz', 'get')['operationId']).toBe('getReadiness');
    const operations = Object.entries(at(doc, 'paths')).flatMap(([path, methods]) =>
      Object.entries(methods as Json).map(
        ([method, op]) => `${(op as Json)['operationId'] as string} ${method} ${path}`,
      ),
    );
    expect(operations.sort()).toEqual(
      [
        'getHealth get /healthz',
        'getReadiness get /readyz',
        'getMe get /me',
        'login post /auth/login',
        'logout post /auth/logout',
        'logoutAll post /auth/logout-all',
        'refreshSession post /auth/refresh',
        'resetPassword post /auth/reset-password',
        'signup post /auth/signup',
        'verifyEmail post /auth/verify-email',
        'resendVerification post /auth/resend-verification',
        'getOwnAccessRequest get /me/access-request',
        'sendAccessRequest post /me/access-request',
      ].sort(),
    );
  });

  it('[NFR-SEC-01] documents Set-Cookie on the responses that set the session cookies', () => {
    for (const [path, status] of [
      ['/auth/login', '200'],
      ['/auth/refresh', '204'],
      ['/auth/logout', '204'],
      ['/auth/logout-all', '204'],
    ] as const) {
      expect(at(doc, 'paths', path, 'post', 'responses', status, 'headers'), path).toHaveProperty(
        'Set-Cookie',
      );
    }
    expect(at(doc, 'paths', '/me', 'get', 'responses', '200', 'headers')).not.toHaveProperty(
      'Set-Cookie',
    );
  });

  it('[NFR-API-01] a 202 with no body documents no content', () => {
    const accepted = at(doc, 'paths', '/auth/signup', 'post', 'responses', '202');
    expect(accepted['content']).toBeUndefined();
  });

  it('[NFR-SEC-05] documents Retry-After on 423 and 429 responses', () => {
    const responses = at(doc, 'paths', '/auth/login', 'post', 'responses');
    for (const status of ['423', '429']) {
      expect(at(responses, status, 'headers'), status).toHaveProperty('Retry-After');
    }
    expect(at(responses, '401', 'headers')).not.toHaveProperty('Retry-After');
  });

  it('[NFR-API-01] declares each operation access level', () => {
    expect(at(doc, 'paths', '/healthz', 'get')['x-access']).toBe('public');
    expect(at(doc, 'paths', '/readyz', 'get')['x-access']).toBe('public');
  });

  it('[NFR-API-01] has a Problem schema whose code is an extensible ErrorCode enum equal to the registry', () => {
    const schemas = at(doc, 'components', 'schemas');
    // Codes grow every slice and clients fall back on unknown ones, so the enums are
    // published as x-extensible-enum: a new code is not a breaking change (ADR-0008).
    expect(at(schemas, 'ErrorCode')['x-extensible-enum']).toEqual([...ERROR_CODES]);
    expect(at(schemas, 'ErrorCode')).not.toHaveProperty('enum');
    expect(at(schemas, 'FieldError', 'properties', 'code')['x-extensible-enum']).toEqual([
      ...FIELD_CODES,
    ]);
    expect(at(schemas, 'FieldError', 'properties', 'code')).not.toHaveProperty('enum');
    expect(at(schemas, 'Problem', 'properties', 'code')).toEqual({
      $ref: '#/components/schemas/ErrorCode',
    });
    expect(at(schemas, 'Problem')['required']).toEqual(
      expect.arrayContaining(['type', 'title', 'status', 'code', 'correlationId']),
    );
  });

  it('[NFR-API-01] every operation answers errors with the Problem response, and lists its own codes', () => {
    for (const path of ['/healthz', '/readyz']) {
      const responses = at(doc, 'paths', path, 'get', 'responses');
      expect(responses['default'], path).toEqual({ $ref: '#/components/responses/Problem' });
    }
    const notReady = at(doc, 'paths', '/readyz', 'get', 'responses', '503');
    expect(notReady['x-error-codes']).toEqual(['SERVICE_UNAVAILABLE']);
    expect(at(notReady, 'content', 'application/problem+json', 'schema')).toEqual({
      $ref: '#/components/schemas/Problem',
    });
  });

  it('[NFR-API-01] declares the X-Request-Id header on success and error responses', () => {
    const header = { $ref: '#/components/headers/XRequestId' };
    expect(at(doc, 'paths', '/healthz', 'get', 'responses', '200', 'headers')).toEqual({
      'X-Request-Id': header,
    });
    expect(at(doc, 'components', 'responses', 'Problem', 'headers')).toEqual({
      'X-Request-Id': header,
    });
    expect(at(doc, 'components', 'headers', 'XRequestId', 'schema')).toEqual({
      type: 'string',
      pattern: '^[A-Za-z0-9._-]{8,36}$',
    });
  });

  it('[NFR-API-01] generation is deterministic and matches the committed document', () => {
    expect(serializeOpenApiDocument()).toBe(serializeOpenApiDocument());
    expect(readFileSync(COMMITTED, 'utf8')).toBe(serializeOpenApiDocument());
  });

  it('[NFR-SEC-01] each access level lists the cookies and CSRF header it requires', () => {
    const op = (method: 'get' | 'post', access: (typeof ACCESS_LEVELS)[number]) => ({
      method,
      path: `/${access}/${method}`,
      operationId: `${access}${method}`.replace('-', ''),
      summary: 'test only',
      access,
      responses: { 204: z.void() },
    });
    const built = buildOpenApiDocument(
      ACCESS_LEVELS.flatMap((access) => [op('get', access), op('post', access)]),
    ) as unknown as Json;
    const security = (access: string, method: string) =>
      at(built, 'paths', `/${access}/${method}`, method)['security'];

    expect(security('public', 'get')).toBeUndefined();
    expect(security('public', 'post')).toBeUndefined();
    expect(security('refresh', 'post')).toEqual([{ refreshCookie: [], csrfHeader: [] }]);
    for (const access of ['user', 'no-role', 'admin']) {
      expect(security(access, 'get')).toEqual([{ accessCookie: [] }]);
      expect(security(access, 'post')).toEqual([{ accessCookie: [], csrfHeader: [] }]);
    }
    expect(at(built, 'components', 'securitySchemes')).toEqual({
      accessCookie: { type: 'apiKey', in: 'cookie', name: 'po_access' },
      refreshCookie: { type: 'apiKey', in: 'cookie', name: 'po_refresh' },
      csrfHeader: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
    });
  });

  it('[FR-ADM-02] an operation flagged ifMatch documents a required If-Match header', () => {
    const built = buildOpenApiDocument([
      {
        method: 'patch',
        path: '/items/:id',
        operationId: 'updateItem',
        summary: 'test only',
        access: 'admin',
        ifMatch: 'required',
        request: { params: z.strictObject({ id: z.uuid() }), body: z.strictObject({}) },
        responses: { 200: z.strictObject({}) },
      },
    ]) as unknown as Json;
    const parameters = at(built, 'paths', '/items/{id}', 'patch')['parameters'] as Json[];
    expect(parameters).toContainEqual(
      expect.objectContaining({ in: 'header', name: 'If-Match', required: true }),
    );
  });

  it('[NFR-API-01] documents a 204 response without a body', () => {
    const built = buildOpenApiDocument([
      {
        method: 'delete',
        path: '/items/:id',
        operationId: 'deleteItem',
        summary: 'test only',
        access: 'public',
        request: { params: z.strictObject({ id: z.uuid() }) },
        responses: { 204: z.void() },
      },
    ]) as unknown as Json;
    const noContent = at(built, 'paths', '/items/{id}', 'delete', 'responses', '204');
    expect(noContent['content']).toBeUndefined();
    expect(noContent['description']).toBe('No content');
  });
});
