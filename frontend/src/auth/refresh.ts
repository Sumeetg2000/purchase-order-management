import { CSRF_COOKIE, CSRF_HEADER, type ErrorCode } from '@po/contracts';
import type { Middleware } from 'openapi-fetch';
import { NetworkError, parseProblem } from '../api/client';
import { readCookie } from '../api/cookies';
import type { ProblemLike } from '../errors/messages';

// Silent refresh (ADR-0018, amended 2026-11-03; research R17): only ACCESS_TOKEN_EXPIRED
// triggers it, one refresh at a time within the tab, and each waiting call is retried
// once. Tabs are not coordinated: the API's 10-second sibling window lets several tabs
// refresh at once.

/** Answers that mean the session is over: from a refresh, or (SESSION_*) from any call. */
const REFRESH_ENDS: ReadonlySet<string> = new Set<ErrorCode>([
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'ACCOUNT_DEACTIVATED',
  'UNAUTHENTICATED',
]);
const ANY_CALL_ENDS: ReadonlySet<string> = new Set<ErrorCode>([
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'ACCOUNT_DEACTIVATED',
]);

/**
 * A refresh's outcome. A refusal for the session ends it; any other failure (a server
 * error) is passed to the waiting calls and the session stays. An unreachable API
 * rejects with NetworkError, which the waiting calls get too.
 */
export type RefreshOutcome =
  | { ok: true }
  | { ok: false; ends: true; problem: ProblemLike }
  | { ok: false; ends: false; response: Response };

export interface Refresher {
  refresh(): Promise<RefreshOutcome>;
}

type Fetch = (request: Request) => Promise<Response>;

/** The problem in a response, read from a copy so the response stays readable. */
async function problemIn(response: Response): Promise<ProblemLike> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return parseProblem(response, body);
}

export function createRefresher(options: {
  baseUrl: string;
  fetch: Fetch;
  cookies: () => string;
}): Refresher {
  let inFlight: Promise<RefreshOutcome> | undefined;

  async function attempt(): Promise<RefreshOutcome> {
    let response: Response;
    try {
      response = await options.fetch(
        new Request(`${options.baseUrl}/auth/refresh`, {
          method: 'POST',
          headers: { [CSRF_HEADER]: readCookie(options.cookies(), CSRF_COOKIE) ?? '' },
        }),
      );
    } catch (cause) {
      throw cause instanceof NetworkError ? cause : new NetworkError({ cause });
    }
    if (response.ok) return { ok: true };
    const problem = await problemIn(response);
    return REFRESH_ENDS.has(problem.code)
      ? { ok: false, ends: true, problem }
      : { ok: false, ends: false, response };
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
 * openapi-fetch middleware: on 401 ACCESS_TOKEN_EXPIRED, refresh and retry the call once.
 * SESSION_REVOKED, SESSION_EXPIRED or ACCOUNT_DEACTIVATED from any call, or a refresh
 * refused for the session, ends it.
 */
export function expiredAccessMiddleware(options: {
  refresher: Refresher;
  fetch: Fetch;
  onSessionEnded: (problem: ProblemLike) => void;
  /** A call answered NO_ROLE_ASSIGNED: the user belongs on Access pending. */
  onNoRoleAssigned: () => void;
}): Middleware {
  // A copy of each call as sent, so its body can be sent again.
  const sent = new Map<string, Request>();
  return {
    onRequest({ request, id }) {
      if (!isAccountCall(request)) sent.set(id, request.clone());
      return undefined;
    },
    onError({ id }) {
      // No response will come for this call (the network failed): drop its copy.
      sent.delete(id);
      return undefined;
    },
    async onResponse({ response, id }) {
      const original = sent.get(id);
      sent.delete(id);
      if (!original) return undefined;
      if (response.status === 403) {
        if ((await problemIn(response)).code === 'NO_ROLE_ASSIGNED') options.onNoRoleAssigned();
        return undefined;
      }
      if (response.status !== 401) return undefined;
      const problem = await problemIn(response);
      if (ANY_CALL_ENDS.has(problem.code)) {
        options.onSessionEnded(problem);
        return undefined;
      }
      if (problem.code !== 'ACCESS_TOKEN_EXPIRED') return undefined;
      const outcome = await options.refresher.refresh();
      if (outcome.ok) {
        // Sent directly, not through the middleware, so it is retried at most once.
        return options.fetch(original);
      }
      if (outcome.ends) {
        options.onSessionEnded(outcome.problem);
        return undefined;
      }
      // A passing failure: this call fails with it, and the session stays.
      return outcome.response.clone();
    },
  };
}
