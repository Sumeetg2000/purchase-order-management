import type { Logger } from 'pino';

/** What a service needs to know about the request it serves. */
export interface RequestContext {
  requestId: string;
  /** The request's logger, bound to its correlation id. */
  logger: Logger;
  /** The client's address (req.ip, behind the single trusted proxy). */
  ip: string;
  /** The client's user agent, truncated to what a session keeps. */
  userAgent: string;
}
