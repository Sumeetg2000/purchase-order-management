import { ERROR_REGISTRY, type AppError } from '@po/contracts';
import type { Response } from 'express';
import { requestIdOf } from './middleware/correlation.js';

/**
 * Writes an AppError as an RFC 9457 problem document (ADR-0007): title and status from
 * the registry, the request's correlation id, and field details where the code allows
 * them. Records the code for the error metrics.
 */
export function sendProblem(res: Response, error: AppError): void {
  const entry = ERROR_REGISTRY[error.code];
  res.locals['problemCode'] = error.code;
  res
    .status(entry.status)
    .type('application/problem+json')
    .json({
      type: 'about:blank',
      title: entry.title,
      status: entry.status,
      code: error.code,
      correlationId: requestIdOf(res),
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(entry.fieldDetails && error.details?.length ? { details: error.details } : {}),
    });
}
