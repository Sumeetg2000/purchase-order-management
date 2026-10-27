import { AppError } from '@po/contracts';
import express, { type Request, type RequestHandler } from 'express';

export const BODY_LIMIT_BYTES = 1024 * 1024;

function hasBody(req: Request): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

/**
 * Body handling for every request that carries one, in this order (ADR-0007):
 * 1. over 1 MB by Content-Length → 413, before reading or parsing
 * 2. not application/json → 400 UNSUPPORTED_MEDIA_TYPE
 * 3. parse; malformed JSON (or a streamed body over the limit) is mapped by the error
 *    middleware from the parser's error type.
 */
export function parseJson(): RequestHandler {
  const json = express.json({ limit: BODY_LIMIT_BYTES, strict: true, type: 'application/json' });

  return (req, res, next) => {
    if (!hasBody(req)) {
      next();
      return;
    }
    const refuse = (error: AppError) => {
      // Drain the unread body so the connection can carry the response.
      req.resume();
      next(error);
    };
    if (Number(req.headers['content-length']) > BODY_LIMIT_BYTES) {
      refuse(new AppError('PAYLOAD_TOO_LARGE'));
      return;
    }
    if (req.is('application/json') === false) {
      refuse(
        new AppError('VALIDATION_FAILED', {
          details: [{ path: 'header.content-type', code: 'UNSUPPORTED_MEDIA_TYPE' }],
        }),
      );
      return;
    }
    json(req, res, next);
  };
}
