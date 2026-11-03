import { describe, expect, it, vi } from 'vitest';
import { createRefresher, expiredAccessMiddleware } from '../src/auth/refresh';
import { NetworkError } from '../src/api/client';
import type { ProblemLike } from '../src/errors/messages';

// The web app refreshes only on ACCESS_TOKEN_EXPIRED, once at a time within the tab, and
// retries each waiting request once (ADR-0018, amended 2026-11-03; research R17).

const BASE = 'http://localhost/api';

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: code,
      status,
      code,
      correlationId: 'r',
      ...extra,
    }),
    {
      status,
      headers: { 'Content-Type': 'application/problem+json' },
    },
  );
}

/** A fake API: /auth/refresh answers `refreshWith`; other calls follow `answers` in order. */
function fakeApi(options: { refreshWith?: () => Response; answers: (() => Response)[] }) {
  const calls: string[] = [];
  const answers = [...options.answers];
  const fetch = vi.fn((request: Request) => {
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (path === '/api/auth/refresh') {
      return Promise.resolve(
        (options.refreshWith ?? (() => new Response(null, { status: 204 })))(),
      );
    }
    const next = answers.shift();
    if (!next) throw new Error(`no answer left for ${path}`);
    return Promise.resolve(next());
  });
  return { fetch, calls };
}

function setup(options: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi(options);
  const ended: ProblemLike[] = [];
  const refresher = createRefresher({
    baseUrl: BASE,
    fetch: api.fetch,
    cookies: () => 'po_csrf=c',
  });
  const middleware = expiredAccessMiddleware({
    refresher,
    fetch: api.fetch,
    onSessionEnded: (p) => ended.push(p),
  });
  /** A call through the middleware, as openapi-fetch would make it. */
  async function call(path: string, id: string) {
    const request = new Request(`${BASE}${path}`, { method: 'POST', body: '{"a":1}' });
    const options = { id, schemaPath: path, params: {}, options: {} as never };
    const sent = (await middleware.onRequest?.({ ...options, request })) ?? request;
    const response = await api.fetch(sent instanceof Request ? sent : request);
    const result = await middleware.onResponse?.({ ...options, request, response });
    return result instanceof Response ? result : response;
  }
  return { ...api, ended, refresher, call };
}

describe('[NFR-FE-02] refresh on ACCESS_TOKEN_EXPIRED', () => {
  it('[NFR-FE-02] refreshes once and retries the call, which then succeeds', async () => {
    const t = setup({
      answers: [() => problem(401, 'ACCESS_TOKEN_EXPIRED'), () => new Response('{}')],
    });
    const res = await t.call('/orders', '1');
    expect(res.status).toBe(200);
    expect(t.calls).toEqual(['POST /api/orders', 'POST /api/auth/refresh', 'POST /api/orders']);
  });

  it('[NFR-FE-02] the retried call keeps its body', async () => {
    const t = setup({
      answers: [() => problem(401, 'ACCESS_TOKEN_EXPIRED'), () => new Response('{}')],
    });
    await t.call('/orders', '1');
    const retried = t.fetch.mock.calls[2]?.[0];
    expect(await retried?.text()).toBe('{"a":1}');
  });

  it('[NFR-FE-02] sends the CSRF cookie with the refresh', async () => {
    const t = setup({
      answers: [() => problem(401, 'ACCESS_TOKEN_EXPIRED'), () => new Response('{}')],
    });
    await t.call('/orders', '1');
    expect(t.fetch.mock.calls[1]?.[0].headers.get('X-CSRF-Token')).toBe('c');
  });

  it('[NFR-FE-02] never refreshes on any other 401, such as UNAUTHENTICATED or a login failure', async () => {
    for (const code of ['UNAUTHENTICATED', 'INCORRECT_PASSWORD', 'SESSION_EXPIRED']) {
      const t = setup({ answers: [() => problem(401, code)] });
      const res = await t.call('/orders', '1');
      expect(res.status, code).toBe(401);
      expect(t.calls, code).toEqual(['POST /api/orders']);
    }
  });

  it('[NFR-FE-02] concurrent expired calls share one refresh, and each retries once', async () => {
    const t = setup({
      answers: [
        () => problem(401, 'ACCESS_TOKEN_EXPIRED'),
        () => problem(401, 'ACCESS_TOKEN_EXPIRED'),
        () => new Response('{}'),
        () => new Response('{}'),
      ],
    });
    const results = await Promise.all([t.call('/a', '1'), t.call('/b', '2')]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(t.calls.filter((c) => c.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('[NFR-FE-02] a call still expired after its retry is not retried again', async () => {
    const t = setup({
      answers: [
        () => problem(401, 'ACCESS_TOKEN_EXPIRED'),
        () => problem(401, 'ACCESS_TOKEN_EXPIRED'),
      ],
    });
    const res = await t.call('/orders', '1');
    expect(res.status).toBe(401);
    expect(t.calls.filter((c) => c.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('[NFR-FE-02] a refresh that fails ends the session with its problem, reason included', async () => {
    const t = setup({
      refreshWith: () => problem(401, 'SESSION_REVOKED', { reason: 'ROLES_CHANGED' }),
      answers: [() => problem(401, 'ACCESS_TOKEN_EXPIRED')],
    });
    const res = await t.call('/orders', '1');
    expect(res.status).toBe(401);
    expect(t.ended).toEqual([
      expect.objectContaining({ code: 'SESSION_REVOKED', reason: 'ROLES_CHANGED' }),
    ]);
  });

  it('[NFR-FE-02] an unreachable refresh keeps the session: the waiting call fails with NetworkError', async () => {
    const t = setup({
      refreshWith: () => {
        throw new TypeError('offline');
      },
      answers: [() => problem(401, 'ACCESS_TOKEN_EXPIRED')],
    });
    await expect(t.call('/orders', '1')).rejects.toBeInstanceOf(NetworkError);
    expect(t.ended).toEqual([]);
  });

  it('[NFR-FE-02] a refresh that fails with a server error keeps the session: the waiting calls get that error', async () => {
    const t = setup({
      refreshWith: () => problem(503, 'SERVICE_UNAVAILABLE'),
      answers: [
        () => problem(401, 'ACCESS_TOKEN_EXPIRED'),
        () => problem(401, 'ACCESS_TOKEN_EXPIRED'),
      ],
    });
    const results = await Promise.all([t.call('/a', '1'), t.call('/b', '2')]);
    expect(results.map((r) => r.status)).toEqual([503, 503]);
    for (const res of results) {
      expect(await res.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }
    expect(t.ended).toEqual([]);
  });

  it.each(['SESSION_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DEACTIVATED', 'UNAUTHENTICATED'])(
    '[NFR-FE-02] a refresh refused with %s ends the session',
    async (code) => {
      const t = setup({
        refreshWith: () => problem(401, code),
        answers: [() => problem(401, 'ACCESS_TOKEN_EXPIRED')],
      });
      await t.call('/orders', '1');
      expect(t.ended).toEqual([expect.objectContaining({ code })]);
    },
  );

  it.each(['SESSION_REVOKED', 'SESSION_EXPIRED'])(
    '[NFR-FE-02] %s from any call ends the session, without a refresh',
    async (code) => {
      const extra = code === 'SESSION_REVOKED' ? { reason: 'ROLES_CHANGED' } : {};
      const t = setup({ answers: [() => problem(401, code, extra)] });
      await t.call('/orders', '1');
      expect(t.ended).toEqual([expect.objectContaining({ code })]);
      expect(t.calls).toEqual(['POST /api/orders']);
    },
  );

  it('[NFR-FE-02] ACCOUNT_DEACTIVATED from any call ends the session', async () => {
    const t = setup({ answers: [() => problem(401, 'ACCOUNT_DEACTIVATED')] });
    await t.call('/orders', '1');
    expect(t.ended).toEqual([expect.objectContaining({ code: 'ACCOUNT_DEACTIVATED' })]);
    expect(t.calls).toEqual(['POST /api/orders']);
  });
});
