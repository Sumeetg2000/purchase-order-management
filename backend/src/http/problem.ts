import type { Response } from 'express';
import { requestIdOf } from './middleware/correlation.js';

export interface ProblemInput {
  status: number;
  code: string;
  title: string;
  detail?: string;
}

/**
 * Writes an RFC 9457 problem document and records its code for the error metrics.
 * The error middleware (US3) replaces this with the registry-typed renderer.
 */
export function sendProblem(res: Response, problem: ProblemInput): void {
  res.locals['problemCode'] = problem.code;
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({ type: 'about:blank', ...problem, correlationId: requestIdOf(res) });
}
