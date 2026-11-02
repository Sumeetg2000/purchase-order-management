import { AppError } from '@po/contracts';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { mapDbError } from '../../db/errors.js';
import { sendProblem } from '../problem.js';

/** Any request no route matched, including an undefined method on a known path. */
export function notFound(): RequestHandler {
  return (_req, _res, next) => {
    next(new AppError('NOT_FOUND'));
  };
}

// body-parser marks its errors with a `type` code; mapped here by code, never by message.
function fromBodyParser(error: unknown): AppError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const type: unknown = (error as { type?: unknown }).type;
  switch (type) {
    case 'entity.too.large':
      return new AppError('PAYLOAD_TOO_LARGE');
    case 'entity.parse.failed':
      return new AppError('VALIDATION_FAILED', {
        details: [{ path: 'body', code: 'MALFORMED_JSON' }],
      });
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return new AppError('VALIDATION_FAILED', {
        details: [{ path: 'header.content-type', code: 'UNSUPPORTED_MEDIA_TYPE' }],
      });
    default:
      return undefined;
  }
}

// Express and body-parser raise client errors (an undecodable path parameter, a body the
// client aborted, an invalid size header) with a 4xx `status`. They are the client's
// fault, never a 500.
function fromClientHttpError(error: unknown): AppError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status: unknown = (error as { status?: unknown }).status;
  if (typeof status !== 'number' || status < 400 || status > 499) return undefined;
  if (status === 413) return new AppError('PAYLOAD_TOO_LARGE');
  const path = error instanceof URIError ? 'path' : 'body';
  return new AppError('VALIDATION_FAILED', { details: [{ path, code: 'INVALID_FORMAT' }] });
}

/** Translates anything thrown into a registered code, or INTERNAL_ERROR (logged in full). */
export function toAppError(error: unknown, logger: Logger): AppError {
  if (error instanceof AppError) return error;
  const parsed = fromBodyParser(error) ?? fromClientHttpError(error);
  if (parsed) return parsed;
  const fromDatabase = mapDbError(error, { logger });
  if (fromDatabase) return fromDatabase;
  logger.error({ err: error }, 'unhandled error');
  return new AppError('INTERNAL_ERROR', { cause: error });
}

/**
 * The one error renderer: every failure leaves as problem+json with a registered code and
 * the correlation id. A 500 carries no internal detail; the log line has the full error.
 */
export function errorHandler(): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      req.log.error({ err: error }, 'error after the response started');
      next(error);
      return;
    }
    sendProblem(res, toAppError(error, req.log));
  };
}
