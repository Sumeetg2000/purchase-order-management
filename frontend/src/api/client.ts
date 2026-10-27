import { ERROR_REGISTRY, problemSchema, type Problem } from '@po/contracts';
import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema';

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

export function createApiClient(options: ClientOptions = {}) {
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request));
  return createClient<paths>({
    baseUrl: API_BASE_URL,
    ...options,
    fetch: async (request: Request) => {
      try {
        return await send(request);
      } catch (cause) {
        throw new NetworkError({ cause });
      }
    },
  });
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
