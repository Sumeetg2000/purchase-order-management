import type { Request, Response } from 'express';
import { USER_AGENT_MAX_LENGTH } from '../auth/constants.js';
import type { RequestContext } from '../lib/request-context.js';
import { requestIdOf } from './middleware/correlation.js';

/** The request context a route hands its service. */
export function requestContext(req: Request, res: Response): RequestContext {
  return {
    requestId: requestIdOf(res),
    logger: req.log,
    ip: req.ip ?? '',
    userAgent: (req.get('user-agent') ?? '').slice(0, USER_AGENT_MAX_LENGTH),
  };
}
