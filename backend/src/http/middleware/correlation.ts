import { REQUEST_ID_PATTERN } from '@po/contracts';
import type { RequestHandler, Response } from 'express';
import { uuidv7 } from '../../lib/uuid.js';

// REQUEST_ID_PATTERN allows up to 36 characters: room for a UUID, and below the
// 43-character run the log checks treat as a token, so a client id can never look like a
// secret in the logs.

/**
 * Accepts the client's X-Request-Id if it is well formed, otherwise generates a UUIDv7.
 * The id is echoed in the response header, bound to every log line (pino-http reads
 * req.id), put in problem bodies, and passed to withTransaction as the request id.
 */
export function correlation(): RequestHandler {
  return (req, res, next) => {
    const supplied = req.get('x-request-id');
    const id = supplied !== undefined && REQUEST_ID_PATTERN.test(supplied) ? supplied : uuidv7();
    req.id = id;
    res.locals['requestId'] = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

export function requestIdOf(res: Response): string {
  const id: unknown = res.locals['requestId'];
  if (typeof id !== 'string') throw new Error('correlation middleware did not run');
  return id;
}
