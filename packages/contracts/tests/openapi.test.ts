import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/index.js';
import { generateOpenApiDocument, serializeOpenApiDocument } from '../src/openapi.js';

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

  it('[NFR-API-01] documents getHealth and getReadiness, and nothing else yet', () => {
    expect(at(doc, 'paths', '/healthz', 'get')['operationId']).toBe('getHealth');
    expect(at(doc, 'paths', '/readyz', 'get')['operationId']).toBe('getReadiness');
    expect(Object.keys(at(doc, 'paths')).sort()).toEqual(['/healthz', '/readyz']);
  });

  it('[NFR-API-01] declares each operation access level', () => {
    expect(at(doc, 'paths', '/healthz', 'get')['x-access']).toBe('public');
    expect(at(doc, 'paths', '/readyz', 'get')['x-access']).toBe('public');
  });

  it('[NFR-API-01] has a Problem schema whose code is an ErrorCode enum equal to the registry', () => {
    const schemas = at(doc, 'components', 'schemas');
    expect(at(schemas, 'ErrorCode')['enum']).toEqual([...ERROR_CODES]);
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
});
