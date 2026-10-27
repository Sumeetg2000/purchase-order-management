import { ERROR_REGISTRY, problemSchema, type Problem } from '@po/contracts';
import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema';

// The typed API client (ADR-0008, research R12): openapi-fetch over the types generated
// from the committed OpenAPI document (`npm run contract:types`). Same origin: nginx and
// the Vite dev proxy forward /api to the API.

export const API_BASE_URL = '/api';

let lastRequestId: string | undefined;

/** The X-Request-Id of the last API response, for error screens with no problem document. */
export function getLastRequestId(): string | undefined {
  return lastRequestId;
}

export function createApiClient(options: ClientOptions = {}) {
  const client = createClient<paths>({ baseUrl: API_BASE_URL, ...options });
  client.use({
    onResponse({ response }) {
      lastRequestId = response.headers.get('x-request-id') ?? lastRequestId;
      return undefined;
    },
  });
  return client;
}

/** An API error carried as an exception, for queries and route errors. */
export class ProblemError extends Error {
  override readonly name = 'ProblemError';

  constructor(readonly problem: Problem) {
    super(problem.title);
  }
}

export const api = createApiClient();

/**
 * The problem document of an error response. A body that isn't one (an unexpected proxy
 * page, say) becomes INTERNAL_ERROR, keeping the response's request id so an error screen
 * can still show it.
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
