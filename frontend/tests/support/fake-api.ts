import { API_PATH_PREFIX } from '@po/contracts';
import { vi } from 'vitest';

// A stand-in for the API in component tests: a handler per "METHOD /path" answers each
// call made through the real API client (global fetch).

export type Handler = (request: Request) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function problem(
  status: number,
  code: string,
  { headers = {}, ...extra }: Record<string, unknown> & { headers?: Record<string, string> } = {},
) {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: code,
      status,
      code,
      correlationId: 'req-1',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

export const ME = {
  id: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f',
  name: 'Asha Rao',
  email: 'asha@example.local',
  roles: ['BUYER'],
  status: 'ACTIVE',
  createdAt: '2026-11-01T09:00:00.000Z',
};

/** Installs the fake API; returns the requests it saw. Unknown routes are a test failure. */
export function fakeApi(handlers: Record<string, Handler>) {
  const seen: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      seen.push(request.clone());
      const key = `${request.method} ${new URL(request.url).pathname.slice(API_PATH_PREFIX.length)}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`fake API has no handler for ${key}`);
      return handler(request);
    }),
  );
  return seen;
}
