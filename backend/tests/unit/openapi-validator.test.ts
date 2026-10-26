import { describe, expect, it } from 'vitest';
import { matchDocumentedPath } from '../support/openapi-validator.js';

describe('[NFR-API-01] OpenAPI path matching', () => {
  it('[NFR-API-01] prefers a literal path over a templated sibling, whatever the key order', () => {
    const paths = ['/orders/{id}', '/orders/outstanding', '/orders/{id}/lines/{lineId}'];
    expect(matchDocumentedPath(paths, '/orders/outstanding')).toBe('/orders/outstanding');
    expect(matchDocumentedPath(paths, '/orders/123')).toBe('/orders/{id}');
    expect(matchDocumentedPath(paths, '/orders/1/lines/2')).toBe('/orders/{id}/lines/{lineId}');
    expect(matchDocumentedPath(paths, '/vendors')).toBeUndefined();
  });
});
