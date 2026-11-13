import {
  AppError,
  fieldErrors,
  versionFromEtag,
  type FieldError,
  type OperationContract,
} from '@po/contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';

export { ACCESS_LEVELS, type Access, type HttpMethod } from '@po/contracts';

/**
 * The single way to register an HTTP route. Production routes spread an operation from
 * @po/contracts (OPERATIONS), the same definition the OpenAPI document is generated from
 * (ADR-0008), so a served route can't drift from its documentation. createApp validates
 * each request against these schemas before the handler.
 */
export interface RouteDefinition extends OperationContract {
  handler: (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
}

export function defineRoute<const R extends RouteDefinition>(route: R): R {
  return route;
}

/**
 * A route without a query or body schema accepts none (strict by default, ADR-0007).
 * Path parameters always come from the route pattern itself.
 */
function undeclared(part: 'params' | 'query' | 'body', prefix: string, raw: unknown): FieldError[] {
  if (part === 'params' || raw === undefined) return [];
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return Object.keys(raw).map((key) => ({ path: `${prefix}.${key}`, code: 'UNKNOWN_FIELD' }));
  }
  return [{ path: prefix, code: 'UNKNOWN_FIELD' }];
}

const PARTS = [
  ['params', 'path'],
  ['query', 'query'],
  ['body', 'body'],
] as const;

// Express 5 path parameters: `:name` or `*name`, the name optionally quoted.
const PATH_PARAMETER = /[:*](?:\w+|"[^"]*")/g;

function isSchema(value: unknown): value is z.core.$ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

/**
 * The first place a schema would take an unknown key without rejecting it, or undefined:
 * z.object drops unknown keys and z.looseObject keeps them, where only z.strictObject
 * rejects them. Walks every nested schema, through wrappers, pipes and lazy schemas.
 */
function nonStrictObjectAt(
  schema: z.core.$ZodType,
  path: string,
  seen: Set<z.core.$ZodType>,
): string | undefined {
  if (seen.has(schema)) return undefined;
  seen.add(schema);
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
  if (def.type === 'object') {
    const catchall = def['catchall'];
    if (!isSchema(catchall) || catchall._zod.def.type !== 'never') return path;
    for (const [key, inner] of Object.entries(def['shape'] as Record<string, z.core.$ZodType>)) {
      const found = nonStrictObjectAt(inner, `${path}.${key}`, seen);
      if (found) return found;
    }
    return undefined;
  }
  const children =
    def.type === 'lazy'
      ? [(def['getter'] as () => unknown)()]
      : Object.entries(def)
          .filter(([key]) => key !== 'checks')
          .flatMap(([, value]) => value);
  const childPath = def.type === 'array' ? `${path}[]` : path;
  for (const child of children) {
    if (!isSchema(child)) continue;
    const found = nonStrictObjectAt(child, childPath, seen);
    if (found) return found;
  }
  return undefined;
}

/**
 * Why a route's request schemas can't guarantee validated input, or undefined (ADR-0007):
 * a path parameter with no params schema would reach the handler unchecked, and a
 * non-strict object would drop or keep unknown fields instead of rejecting them, where a
 * derived field in a body must be refused (ADR-0003).
 */
export function requestSchemaProblem(route: OperationContract): string | undefined {
  const parameters = route.path.match(PATH_PARAMETER) ?? [];
  if (parameters.length > 0 && !route.request?.params) {
    return `has path parameters (${parameters.join(', ')}) but no params schema`;
  }
  for (const [part] of PARTS) {
    const schema = route.request?.[part];
    const at = schema && nonStrictObjectAt(schema, part, new Set());
    if (at) return `accepts unknown fields at ${at}; use z.strictObject`;
  }
  return undefined;
}

const IF_MATCH_PATH = 'header.if-match';
const IDEMPOTENCY_KEY_PATH = 'header.idempotency-key';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A create's Idempotency-Key: required, a UUID (slice 3 research R5), lower-cased. */
function idempotencyKey(header: string | undefined): string | FieldError {
  if (header === undefined) return { path: IDEMPOTENCY_KEY_PATH, code: 'REQUIRED' };
  return UUID.test(header)
    ? header.toLowerCase()
    : { path: IDEMPOTENCY_KEY_PATH, code: 'INVALID_FORMAT' };
}

/** The version a versioned update must name in If-Match (research R14). */
function ifMatchVersion(header: string | undefined): number | FieldError {
  if (header === undefined) return { path: IF_MATCH_PATH, code: 'VERSION_REQUIRED' };
  return versionFromEtag(header) ?? { path: IF_MATCH_PATH, code: 'INVALID_FORMAT' };
}

/** The `id` path parameter validateRequest parsed (idParams: a UUID). */
export function idParamOf(req: Request): string {
  const id = req.params['id'];
  if (typeof id !== 'string') throw new Error('idParamOf on a route without an id parameter');
  return id;
}

/** The Idempotency-Key validateRequest parsed, for an idempotent create's handler. */
export function idempotencyKeyOf(res: Response): string {
  const key = (res.locals['input'] as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  if (typeof key !== 'string') {
    throw new Error('idempotencyKeyOf on a route without Idempotency-Key');
  }
  return key;
}

/** The If-Match version validateRequest parsed, for a versioned update's handler. */
export function ifMatchVersionOf(res: Response): number {
  const version = (res.locals['input'] as { version?: unknown } | undefined)?.version;
  if (typeof version !== 'number') throw new Error('ifMatchVersionOf on a route without If-Match');
  return version;
}

/**
 * Validates path, query and body against the route's schemas before the handler runs.
 * A versioned update's If-Match is parsed first, into `input.version`.
 * Any failure is 400 VALIDATION_FAILED with field details; parsed values replace
 * req.params, req.query and req.body, so a handler can't read the raw input, and are
 * available as res.locals.input.
 */
export function validateRequest(route: RouteDefinition): RequestHandler {
  return (req, res, next) => {
    const details: FieldError[] = [];
    const input: Record<string, unknown> = {};
    if (route.ifMatch === 'required') {
      const version = ifMatchVersion(req.get('if-match'));
      if (typeof version === 'number') input['version'] = version;
      else details.push(version);
    }
    if (route.idempotencyKey === 'required') {
      const key = idempotencyKey(req.get('idempotency-key'));
      if (typeof key === 'string') input['idempotencyKey'] = key;
      else details.push(key);
    }
    for (const [part, prefix] of PARTS) {
      const schema = route.request?.[part];
      const raw: unknown = req[part];
      if (!schema) {
        details.push(...undeclared(part, prefix, raw));
        input[part] = raw;
        continue;
      }
      const result = schema.safeParse(raw, { reportInput: true });
      if (result.success) input[part] = result.data;
      else details.push(...fieldErrors(prefix, result.error.issues));
    }
    if (details.length > 0) {
      next(new AppError('VALIDATION_FAILED', { details }));
      return;
    }
    req.params = input['params'] as Request['params'];
    // Express 5's req.query is a getter that reparses the URL, so it is shadowed, not assigned.
    Object.defineProperty(req, 'query', {
      value: input['query'],
      configurable: true,
      enumerable: true,
      writable: true,
    });
    req.body = input['body'];
    res.locals['input'] = input;
    next();
  };
}
