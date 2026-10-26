import express, { type Express } from 'express';
import type { Metrics } from '../observability/metrics.js';
import { ACCESS_LEVELS, type RouteDefinition } from './define-route.js';
import { metricsMiddleware } from './middleware/metrics.js';

export class RouteRegistrationError extends Error {
  override readonly name = 'RouteRegistrationError';
}

export interface CreateAppOptions {
  routes: readonly RouteDefinition[];
  /** Records request metrics; they are served by the separate metrics listener. */
  metrics?: Metrics;
}

function describeRoute(route: RouteDefinition): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

/** Startup check: every route declares a known access level and documented responses. */
export function validateRoutes(routes: readonly RouteDefinition[]): void {
  const operationIds = new Set<string>();
  const endpoints = new Set<string>();

  for (const route of routes) {
    const label = describeRoute(route);
    const access: unknown = route.access;
    if (!(ACCESS_LEVELS as readonly unknown[]).includes(access)) {
      throw new RouteRegistrationError(
        `Route ${label} declares no valid access level (expected one of: ${ACCESS_LEVELS.join(', ')})`,
      );
    }
    if (Object.keys(route.responses).length === 0) {
      throw new RouteRegistrationError(
        `Route ${label} documents no responses, so it cannot be in the OpenAPI registry`,
      );
    }
    if (operationIds.has(route.operationId)) {
      throw new RouteRegistrationError(`Duplicate operationId "${route.operationId}"`);
    }
    if (endpoints.has(label)) {
      throw new RouteRegistrationError(`Duplicate route ${label}`);
    }
    operationIds.add(route.operationId);
    endpoints.add(label);
  }
}

export function createApp({ routes, metrics }: CreateAppOptions): Express {
  validateRoutes(routes);

  const app = express();
  app.disable('x-powered-by');
  // The nginx edge is the only proxy, and it replaces X-Forwarded-For with the connecting
  // address, so req.ip trusts exactly one hop.
  app.set('trust proxy', 1);
  if (metrics) {
    app.use(metricsMiddleware(metrics));
  }

  for (const route of routes) {
    app.route(route.path)[route.method](route.handler);
  }

  return app;
}
