import type { FieldError } from '@po/contracts';
import { fieldMessages, sentenceFor, type ProblemLike } from '../errors/messages';
import { problemFrom } from '../errors/problem';
import { parseProblem } from './client';

// One way for a form to call the API: an unreachable API, a problem and its Retry-After
// all become one failure the page can show.

export interface ApiFailure {
  problem: ProblemLike & { details?: readonly FieldError[] | undefined };
  retryAfterSeconds?: number;
}

export type ApiOutcome<T> = { ok: true; data: T } | ({ ok: false } & ApiFailure);

export async function submit<T>(
  call: () => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ApiOutcome<T>> {
  let result;
  try {
    result = await call();
  } catch (thrown) {
    // NetworkError: the API couldn't be reached.
    return { ok: false, problem: problemFrom(thrown) };
  }
  if (result.error === undefined) return { ok: true, data: result.data as T };
  const retryAfter = Number(result.response.headers.get('Retry-After') ?? Number.NaN);
  return {
    ok: false,
    problem: parseProblem(result.response, result.error),
    ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
  };
}

/** The failure as the page says it, the wait in minutes where there is one. */
export function failureMessage(failure: ApiFailure): string {
  return sentenceFor(failure.problem, failure.retryAfterSeconds);
}

/** The message for a field's own error, if the failure names that field. */
export function fieldFailure(failure: ApiFailure, path: string): string | undefined {
  const detail = failure.problem.details?.find((d) => d.path === path);
  return detail && fieldMessages[detail.code];
}
