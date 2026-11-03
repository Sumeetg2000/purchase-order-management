import { CSRF_COOKIE, CSRF_HEADER } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { createApiClient, csrfMiddleware, readCookie } from '../src/api/client';

// The web app sends the CSRF cookie's value back as X-CSRF-Token on state-changing calls
// (ADR-0018, research R17). The cookie is readable by design; it is not a credential.

const CSRF = 'a'.repeat(43);

async function sent(method: string, cookies: string): Promise<string | null> {
  const middleware = csrfMiddleware(() => cookies);
  const request = new Request('http://localhost/api/anything', { method });
  const result = await middleware.onRequest?.({
    request,
    schemaPath: '/anything',
    params: {},
    options: {} as never,
    id: 'test',
  });
  return (result instanceof Request ? result : request).headers.get(CSRF_HEADER);
}

describe('[NFR-FE-02] CSRF header', () => {
  it('[NFR-FE-02] sends the po_csrf cookie as X-CSRF-Token on POST, PUT, PATCH and DELETE', async () => {
    expect([CSRF_COOKIE, CSRF_HEADER]).toEqual(['po_csrf', 'X-CSRF-Token']);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await sent(method, `theme=dark; po_csrf=${CSRF}`), method).toBe(CSRF);
    }
  });

  it('[NFR-FE-02] sends nothing on reads', async () => {
    for (const method of ['GET', 'HEAD']) {
      expect(await sent(method, `po_csrf=${CSRF}`), method).toBeNull();
    }
  });

  it('[NFR-FE-02] sends nothing without the cookie; the API then refuses the call', async () => {
    expect(await sent('POST', 'theme=dark')).toBeNull();
  });

  it('[NFR-FE-02] a malformed cookie value sends no header instead of breaking the call', async () => {
    expect(readCookie('po_csrf=%E0%A4%A', 'po_csrf')).toBeUndefined();
    expect(await sent('POST', 'po_csrf=%E0%A4%A')).toBeNull();
  });

  it('[NFR-FE-02] reads one cookie by exact name and decodes it', () => {
    expect(readCookie('xpo_csrf=no; po_csrf=a%3Db', 'po_csrf')).toBe('a=b');
    expect(readCookie('', 'po_csrf')).toBeUndefined();
  });

  it('[NFR-FE-02] the API client applies it to its calls', async () => {
    const headers: (string | null)[] = [];
    const client = createApiClient({
      baseUrl: 'http://localhost/api',
      cookies: () => `po_csrf=${CSRF}`,
      fetch: (request: Request) => {
        headers.push(request.headers.get(CSRF_HEADER));
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    await client.GET('/healthz');
    // No state-changing operation is in the contract until US1, so call one untyped.
    const post = client.POST as unknown as (path: string) => Promise<unknown>;
    await post('/anything');
    expect(headers).toEqual([null, CSRF]);
  });
});
