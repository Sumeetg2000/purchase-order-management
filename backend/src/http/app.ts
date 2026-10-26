import { OPERATIONS, type OperationContract } from '@po/contracts';
import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { serializeError, serializeRequest, serializeResponse } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { ACCESS_LEVELS, validateRequest, type RouteDefinition } from './define-route.js';
import { correlation } from './middleware/correlation.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { metricsMiddleware } from './middleware/metrics.js';
import { parseJson } from './middleware/parse-json.js';
import { originGuard, securityHeaders } from './middleware/security.js';

export class RouteRegistrationError extends Error {
  override readonly name = 'RouteRegistrationError';
}

export interface CreateAppOptions {
  routes: readonly RouteDefinition[];
  /** Every request gets a child logger bound to its correlation id. */
  logger: Logger;
  /** The only origin allowed to call the API (same-origin deployment, ADR-0017). */
  appOrigin: string;
  /** Records request metrics; they are served by the separate metrics listener. */
  metrics?: Metrics;
}

function describeRoute(route: Pick<OperationContract, 'method' | 'path'>): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

/**
 * Startup check: every route declares a known access level and documented responses, and
 * a route that names a contract operation serves it at the contract's method and path.
 */
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
    const contract = (OPERATIONS as Readonly<Record<string, OperationContract | undefined>>)[
      route.operationId
    ];
    if (contract && (contract.method !== route.method || contract.path !== route.path)) {
      throw new RouteRegistrationError(
        `Route ${label} claims operation "${route.operationId}", which the contract defines as ${describeRoute(contract)}`,
      );
    }
    operationIds.add(route.operationId);
    endpoints.add(label);
  }
}

export function createApp({ routes, logger, appOrigin, metrics }: CreateAppOptions): Express {
  validateRoutes(routes);

  const app = express();
  app.disable('x-powered-by');
  // The nginx edge is the only proxy, and it replaces X-Forwarded-For with the connecting
  // address, so req.ip trusts exactly one hop.
  app.set('trust proxy', 1);
  if (metrics) {
    app.use(metricsMiddleware(metrics));
  }
  app.use(correlation());
  app.use(
    pinoHttp({
      logger,
      // Bind only the correlation id to the request's child logger, as `requestId`.
      quietReqLogger: true,
      customAttributeKeys: { reqId: 'requestId' },
      serializers: { err: serializeError, req: serializeRequest, res: serializeResponse },
    }),
  );

  app.use(securityHeaders());
  app.use(originGuard(appOrigin));
  app.use(parseJson());

  for (const route of routes) {
    app.route(route.path)[route.method](validateRequest(route), route.handler);
  }

  app.use(notFound());
  app.use(errorHandler());

  return app;
}
