import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_BASE_URL, createApiClient, parseProblem } from '../src/api/client';

const document = JSON.parse(
  readFileSync(new URL('../../packages/contracts/openapi/openapi.json', import.meta.url), 'utf8'),
) as { servers: { url: string }[] };

function jsonResponse(status: number, body: unknown, type = 'application/json') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': type, 'X-Request-Id': 'req-client-0001' },
  });
}

describe('[NFR-API-01] generated API client', () => {
  it('[NFR-API-01] calls the API under the same prefix the OpenAPI document declares', () => {
    expect(API_BASE_URL).toBe('/api');
    expect(document.servers.map((s) => s.url)).toEqual([API_BASE_URL]);
  });

  it('[NFR-API-01] sends typed requests to the documented paths', async () => {
    const urls: string[] = [];
    const client = createApiClient({
      baseUrl: 'http://localhost/api',
      fetch: (input: Request) => {
        urls.push(input.url);
        return Promise.resolve(jsonResponse(200, { status: 'ok' }));
      },
    });
    const { data } = await client.GET('/healthz');
    expect(data).toEqual({ status: 'ok' });
    expect(urls).toEqual(['http://localhost/api/healthz']);
  });

  it('[NFR-API-01] parses a problem document from an error response', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Service unavailable',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      correlationId: 'req-client-0001',
    };
    const client = createApiClient({
      baseUrl: 'http://localhost/api',
      fetch: () => Promise.resolve(jsonResponse(503, problem, 'application/problem+json')),
    });
    const { error, response } = await client.GET('/readyz');
    expect(parseProblem(response, error)).toEqual(problem);
  });

  it('[NFR-API-01] turns a body that is not a problem document into INTERNAL_ERROR with the response request id', () => {
    const response = new Response('<html>bad gateway</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html', 'X-Request-Id': 'req-client-0002' },
    });
    expect(parseProblem(response, '<html>bad gateway</html>')).toEqual({
      type: 'about:blank',
      title: 'Internal error',
      status: 502,
      code: 'INTERNAL_ERROR',
      correlationId: 'req-client-0002',
    });
  });
});
