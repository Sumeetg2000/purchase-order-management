import type { Response } from 'express';

export interface ProblemInput {
  status: number;
  code: string;
  title: string;
  detail?: string;
}

/**
 * Writes an RFC 9457 problem document and records its code for the error metrics.
 * US3 adds the registry type for `code`, the correlation id, and the error middleware
 * that calls this for thrown errors.
 */
export function sendProblem(res: Response, problem: ProblemInput): void {
  res.locals['problemCode'] = problem.code;
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({ type: 'about:blank', ...problem });
}
