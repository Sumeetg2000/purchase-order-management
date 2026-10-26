import type { RequestHandler } from 'express';
import type { Metrics } from '../../observability/metrics.js';

/** Label for requests that matched no registered route, so raw paths never become labels. */
export const UNMATCHED_ROUTE = 'unmatched';

/** Times every request and counts it under its route pattern once the response is sent. */
export function metricsMiddleware(metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const stop = metrics.requestDuration.startTimer();
    res.once('finish', () => {
      const pattern: unknown = (req.route as { path?: unknown } | undefined)?.path;
      const route = typeof pattern === 'string' ? `${req.baseUrl}${pattern}` : UNMATCHED_ROUTE;
      const labels = {
        method: req.method,
        route,
        status_class: `${String(Math.floor(res.statusCode / 100))}xx`,
      };
      stop(labels);
      metrics.requests.inc(labels);
      const code: unknown = res.locals['problemCode'];
      if (typeof code === 'string') {
        metrics.errors.inc({ route, code });
      }
    });
    next();
  };
}
