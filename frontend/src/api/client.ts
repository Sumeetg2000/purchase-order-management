import { ERROR_REGISTRY, problemSchema, type Problem } from '@po/contracts';
import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema';

// The typed API client (ADR-0008, research R12): openapi-fetch over the types generated
// from the committed OpenAPI document (`npm run contract:types`). Same origin: nginx and
// the Vite dev proxy forward /api to the API.

export const API_BASE_URL = '/api';

export function createApiClient(options: ClientOptions = {}) {
  return createClient<paths>({ baseUrl: API_BASE_URL, ...options });
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
