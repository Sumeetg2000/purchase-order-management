import type { RequestHandler } from 'express';
import type { Metrics } from '../../observability/metrics.js';

/** Label for requests that matched no registered route, so raw paths never become labels. */
export const UNMATCHED_ROUTE = 'unmatched';

// nginx's convention for a request the client closed before the response was sent.
const CLIENT_CLOSED_REQUEST = 499;

/**
 * Times every request and counts it under its route pattern once the response is sent,
 * or once the connection closes first (an abandoned request still counts, as 4xx).
 */
export function metricsMiddleware(metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const stop = metrics.requestDuration.startTimer();
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const pattern: unknown = (req.route as { path?: unknown } | undefined)?.path;
      const status = res.writableFinished ? res.statusCode : CLIENT_CLOSED_REQUEST;
      const route = typeof pattern === 'string' ? `${req.baseUrl}${pattern}` : UNMATCHED_ROUTE;
      const labels = {
        method: req.method,
        route,
        status_class: `${String(Math.floor(status / 100))}xx`,
      };
      stop(labels);
      metrics.requests.inc(labels);
      const code: unknown = res.locals['problemCode'];
      if (typeof code === 'string') {
        metrics.errors.inc({ route, code });
      }
    };
    res.once('finish', record);
    res.once('close', record);
    next();
  };
}
