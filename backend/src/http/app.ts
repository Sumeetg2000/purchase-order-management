import { accessProblem, oneOf, OPERATIONS, type OperationContract } from '@po/contracts';
import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { serializeError, serializeRequest, serializeResponse } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import {
  ACCESS_LEVELS,
  requestSchemaProblem,
  validateRequest,
  type RouteDefinition,
} from './define-route.js';
import { correlation } from './middleware/correlation.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { authenticate, type AuthDependencies } from './middleware/authorize.js';
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
  /**
   * Who is calling, for every route that isn't public. An app with a non-public route
   * and no authenticator fails at startup (deny by default).
   */
  auth?: AuthDependencies;
  /**
   * Tests only: operations for test-only routes (to provoke errors the real routes can't).
   * They can't name a contract operation. The server never passes this; a test checks no
   * other source file mentions it.
   */
  testOnlyOperations?: Readonly<Record<string, OperationContract>>;
}

type Operations = Readonly<Record<string, OperationContract | undefined>>;

function describeRoute(route: Pick<OperationContract, 'method' | 'path'>): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

const CONTRACT_FIELDS = [
  'summary',
  'access',
  'roles',
  'ifMatch',
  'idempotencyKey',
  'bodyLimitBytes',
  'setsCookies',
  'request',
  'responses',
  'errors',
] as const;

/**
 * Startup check: every route declares a known access level and documented responses, and
 * serves exactly one operation of the contract (or, in tests, of the test-only registry),
 * so nothing is served that the OpenAPI document doesn't describe. Its request schemas must
 * cover every path parameter and reject unknown fields at any depth.
 */
export function validateRoutes(
  routes: readonly RouteDefinition[],
  testOnlyOperations: Operations = {},
): void {
  const shadowed = Object.keys(testOnlyOperations).filter((id) => Object.hasOwn(OPERATIONS, id));
  if (shadowed.length > 0) {
    throw new RouteRegistrationError(
      `The test-only registry names contract operations: ${shadowed.join(', ')}`,
    );
  }
  const operationIds = new Set<string>();
  const endpoints = new Set<string>();

  for (const route of routes) {
    const label = describeRoute(route);
    const access: unknown = route.access;
    if (!oneOf(ACCESS_LEVELS, access)) {
      throw new RouteRegistrationError(
        `Route ${label} declares no valid access level (expected one of: ${ACCESS_LEVELS.join(', ')})`,
      );
    }
    const accessMismatch = accessProblem(route);
    if (accessMismatch) {
      throw new RouteRegistrationError(`Route ${label} ${accessMismatch}`);
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
    const contract = Object.hasOwn(OPERATIONS, route.operationId)
      ? (OPERATIONS as Operations)[route.operationId]
      : Object.hasOwn(testOnlyOperations, route.operationId)
        ? testOnlyOperations[route.operationId]
        : undefined;
    if (!contract) {
      throw new RouteRegistrationError(
        `Route ${label} serves operation "${route.operationId}", which is not in the contract`,
      );
    }
    if (contract.method !== route.method || contract.path !== route.path) {
      throw new RouteRegistrationError(
        `Route ${label} claims operation "${route.operationId}", which the contract defines as ${describeRoute(contract)}`,
      );
    }
    // A route spreads its operation and adds a handler. Anything it overrides would be
    // served differently from what the document says, so the fields must be the contract's
    // own values.
    const changed = CONTRACT_FIELDS.filter((field) => route[field] !== contract[field]);
    if (changed.length > 0) {
      throw new RouteRegistrationError(
        `Route ${label} changes ${changed.join(', ')} of contract operation "${route.operationId}"`,
      );
    }
    const schemaProblem = requestSchemaProblem(route);
    if (schemaProblem) {
      throw new RouteRegistrationError(`Route ${label} ${schemaProblem}`);
    }
    operationIds.add(route.operationId);
    endpoints.add(label);
  }
}

/** The steps before a route's handler; a guarded route with no authenticator can't start. */
function requestSteps(route: RouteDefinition, auth: AuthDependencies | undefined) {
  const validate = [parseJson(route.bodyLimitBytes), validateRequest(route)];
  if (route.access === 'public') return validate;
  if (!auth) {
    throw new RouteRegistrationError(
      `Route ${describeRoute(route)} needs authentication, but the app has none`,
    );
  }
  return [authenticate(route, auth), ...validate];
}

export function createApp({
  routes,
  logger,
  appOrigin,
  metrics,
  auth,
  testOnlyOperations,
}: CreateAppOptions): Express {
  validateRoutes(routes, testOnlyOperations);

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

  // ADR-0004 precedence: 401, CSRF, NO_ROLE_ASSIGNED and the access level's FORBIDDEN,
  // then the body and its shape (400). The body is read only once the caller may use the
  // route.
  for (const route of routes) {
    app.route(route.path)[route.method](...requestSteps(route, auth), route.handler);
  }

  app.use(notFound());
  app.use(errorHandler());

  return app;
}
