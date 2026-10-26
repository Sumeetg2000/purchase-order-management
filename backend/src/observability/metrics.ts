import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

// Internal Prometheus metrics (contracts/metrics.md). Labels are bounded: method, the
// registered route pattern, status class and registry code. Never ids, emails, raw
// paths or query strings.

export interface Metrics {
  registry: Registry;
  requestDuration: Histogram<'method' | 'route' | 'status_class'>;
  requests: Counter<'method' | 'route' | 'status_class'>;
  errors: Counter<'route' | 'code'>;
}

/** One registry per process (and per test), so nothing is shared globally. */
export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'po_' });

  return {
    registry,
    requestDuration: new Histogram({
      name: 'po_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_class'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    requests: new Counter({
      name: 'po_http_requests_total',
      help: 'HTTP requests',
      labelNames: ['method', 'route', 'status_class'],
      registers: [registry],
    }),
    errors: new Counter({
      name: 'po_http_errors_total',
      help: 'HTTP error responses by registry code',
      labelNames: ['route', 'code'],
      registers: [registry],
    }),
  };
}

/**
 * The second listener, on METRICS_PORT. It serves only `GET /metrics`, and compose never
 * publishes its port, so the public app can't expose metrics even if misrouted.
 */
export function createMetricsServer(metrics: Metrics): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    metrics.registry.metrics().then(
      (body) => {
        res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(body);
      },
      () => {
        res.writeHead(500).end();
      },
    );
  });
}
