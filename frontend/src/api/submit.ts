import {
  describeFailure,
  fieldMessageFor,
  sentenceOf,
  type FormFields,
  type ProblemLike,
} from '../errors/messages';
import { problemFrom } from '../errors/problem';
import { parseProblem, retryAfterOf } from './client';

// One way for a form to call the API: an unreachable API, a problem and its Retry-After
// all become one failure the page can show.

export interface ApiFailure {
  problem: ProblemLike;
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
  const retryAfterSeconds = retryAfterOf(result.response);
  return {
    ok: false,
    problem: parseProblem(result.response, result.error),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/**
 * The failure as the page says it, the wait in minutes where there is one. `form` names
 * the fields the page highlights itself and labels the rest, so a field error with no
 * field of its own on the page is said here (describeFailure).
 */
export function failureMessage(failure: ApiFailure, form?: FormFields): string {
  return sentenceOf(describeFailure(failure, form));
}

/** The message for a field's own error, if the failure names that field. */
export function fieldFailure(failure: ApiFailure, path: string): string | undefined {
  const detail = failure.problem.details?.find((d) => d.path === path);
  return detail && fieldMessageFor(detail.code);
}
