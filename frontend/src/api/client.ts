import {
  CSRF_COOKIE,
  CSRF_HEADER,
  ERROR_REGISTRY,
  problemSchema,
  requiresCsrf,
  type Problem,
} from '@po/contracts';
import createClient, { type ClientOptions, type Middleware } from 'openapi-fetch';
import { endSession } from '../auth/session-events';
import { createRefresher, expiredAccessMiddleware } from '../auth/refresh';
import type { ProblemLike } from '../errors/messages';
import { documentCookies, readCookie } from './cookies';
import type { paths } from './schema';

export { readCookie } from './cookies';

// The typed API client (ADR-0008, research R12): openapi-fetch over the types generated
// from the committed OpenAPI document (`npm run contract:types`). Same origin: nginx and
// the Vite dev proxy forward /api to the API.

export const API_BASE_URL = '/api';

/** The API couldn't be reached: offline, a dropped connection, DNS. There is no response. */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';

  constructor(options?: { cause?: unknown }) {
    super('The API could not be reached', options);
  }
}

/**
 * Sends the CSRF cookie back as X-CSRF-Token on every state-changing call (ADR-0017,
 * research R17). Without the cookie nothing is sent, and the API refuses the call.
 */
export function csrfMiddleware(cookies: () => string = documentCookies): Middleware {
  return {
    onRequest({ request }) {
      if (!requiresCsrf(request.method)) return undefined;
      const token = readCookie(cookies(), CSRF_COOKIE);
      if (token === undefined) return undefined;
      request.headers.set(CSRF_HEADER, token);
      return request;
    },
  };
}

export interface ApiClientOptions extends ClientOptions {
  /** Where cookies are read from; the browser's document.cookie by default. */
  cookies?: () => string;
  /** Called when the session ends under the user; the session boundary by default. */
  onSessionEnded?: (problem: ProblemLike) => void;
}

/** The API's base URL, absolute: same origin in the browser. */
function defaultBaseUrl(): string {
  const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
  return new URL(API_BASE_URL, origin).href;
}

export function createApiClient({
  cookies = documentCookies,
  onSessionEnded = endSession,
  ...options
}: ApiClientOptions = {}) {
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request));
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  /** One call to the API; an unreachable API becomes a NetworkError. */
  const fetchOnce = async (request: Request) => {
    try {
      return await send(request);
    } catch (cause) {
      throw new NetworkError({ cause });
    }
  };
  const client = createClient<paths>({ ...options, baseUrl, fetch: fetchOnce });
  client.use(
    csrfMiddleware(cookies),
    expiredAccessMiddleware({
      refresher: createRefresher({ baseUrl, fetch: send, cookies }),
      fetch: fetchOnce,
      onSessionEnded,
    }),
  );
  return client;
}

/**
 * An API error carried as an exception, for queries and route errors. Its problem carries
 * the failing request's own id (correlationId), so an error screen never shows another
 * request's.
 */
export class ProblemError extends Error {
  override readonly name = 'ProblemError';

  constructor(readonly problem: Problem) {
    super(problem.title);
  }
}

/** An openapi-fetch result's data, or a ProblemError built from its error response. */
export function dataOrThrow<T>(
  result:
    | { data: T; error?: never; response: Response }
    | { data?: never; error: unknown; response: Response },
): T {
  if (result.error !== undefined) {
    throw new ProblemError(parseProblem(result.response, result.error));
  }
  return result.data as T;
}

export const api = createApiClient();

/**
 * The problem document of an error response. A body that isn't one (an unexpected proxy
 * page, say) becomes INTERNAL_ERROR with that response's own X-Request-Id.
 */
export function parseProblem(response: Response, body: unknown): Problem {
  const contentType = response.headers.get('content-type') ?? '';
  const parsed = problemSchema.safeParse(body);
  if (parsed.success && contentType.startsWith('application/problem+json')) return parsed.data;
  return {
    type: 'about:blank',
    title: ERROR_REGISTRY.INTERNAL_ERROR.title,
    status: response.status,
    code: 'INTERNAL_ERROR',
    correlationId: response.headers.get('x-request-id') ?? '',
  };
}
