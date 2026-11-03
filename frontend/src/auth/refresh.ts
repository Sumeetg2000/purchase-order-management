import { CSRF_COOKIE, CSRF_HEADER } from '@po/contracts';
import type { Middleware } from 'openapi-fetch';
import { readCookie } from '../api/cookies';
import type { ProblemLike } from '../errors/messages';

// Silent refresh (ADR-0018, amended 2026-11-03; research R17): only ACCESS_TOKEN_EXPIRED
// triggers it, one refresh at a time within the tab, and each waiting call is retried
// once. Tabs are not coordinated: the API's 10-second sibling window lets several tabs
// refresh at once.

export type RefreshOutcome = { ok: true } | { ok: false; problem: ProblemLike };

export interface Refresher {
  refresh(): Promise<RefreshOutcome>;
}

type Fetch = (request: Request) => Promise<Response>;

/** The problem in an error response, or INTERNAL_ERROR when its body isn't one. */
async function problemOf(response: Response): Promise<ProblemLike> {
  try {
    const body = (await response.json()) as Partial<Record<string, unknown>>;
    if (typeof body['code'] === 'string') {
      return {
        code: body['code'],
        ...(typeof body['correlationId'] === 'string'
          ? { correlationId: body['correlationId'] }
          : {}),
        ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
      };
    }
  } catch {
    // Not JSON: fall through.
  }
  return { code: 'INTERNAL_ERROR' };
}

export function createRefresher(options: {
  baseUrl: string;
  fetch: Fetch;
  cookies: () => string;
}): Refresher {
  let inFlight: Promise<RefreshOutcome> | undefined;

  async function attempt(): Promise<RefreshOutcome> {
    try {
      const response = await options.fetch(
        new Request(`${options.baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: { [CSRF_HEADER]: readCookie(options.cookies(), CSRF_COOKIE) ?? '' },
        }),
      );
      return response.ok ? { ok: true } : { ok: false, problem: await problemOf(response) };
    } catch {
      // The API is unreachable: the session can't be renewed, so the user logs in again.
      return { ok: false, problem: { code: 'SESSION_EXPIRED' } };
    }
  }

  return {
    refresh: () => {
      inFlight ??= attempt().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

/** Account calls (login, reset, refresh) answer for themselves; the page shows the code. */
function isAccountCall(request: Request): boolean {
  return new URL(request.url).pathname.includes('/auth/');
}

/**
 * openapi-fetch middleware: on 401 ACCESS_TOKEN_EXPIRED, refresh and retry the call once;
 * if the refresh fails, or any call answers ACCOUNT_DEACTIVATED, end the session.
 */
export function expiredAccessMiddleware(options: {
  refresher: Refresher;
  fetch: Fetch;
  onSessionEnded: (problem: ProblemLike) => void;
}): Middleware {
  // A copy of each call as sent, so its body can be sent again.
  const sent = new Map<string, Request>();
  return {
    onRequest({ request, id }) {
      if (!isAccountCall(request)) sent.set(id, request.clone());
      return undefined;
    },
    async onResponse({ response, id }) {
      const original = sent.get(id);
      sent.delete(id);
      if (response.status !== 401 || !original) return undefined;
      const problem = await problemOf(response.clone());
      if (problem.code === 'ACCOUNT_DEACTIVATED') {
        options.onSessionEnded(problem);
        return undefined;
      }
      if (problem.code !== 'ACCESS_TOKEN_EXPIRED') return undefined;
      const outcome = await options.refresher.refresh();
      if (!outcome.ok) {
        options.onSessionEnded(outcome.problem);
        return undefined;
      }
      // Sent directly, not through the middleware, so it is retried at most once.
      return options.fetch(original);
    },
  };
}
