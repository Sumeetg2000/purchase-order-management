import { AppError, type FieldCode, type FieldError, type OperationContract } from '@po/contracts';
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

type ZodIssue = z.core.$ZodIssue;

/** Zod issue → field code (ADR-0007). Codes and origins only, never message text. */
function fieldCode(issue: ZodIssue): FieldCode {
  switch (issue.code) {
    case 'invalid_type':
      // With reportInput, a missing key is the only invalid_type without an input.
      return 'input' in issue && issue.input !== undefined ? 'INVALID_FORMAT' : 'REQUIRED';
    case 'unrecognized_keys':
      return 'UNKNOWN_FIELD';
    case 'too_small':
      return ['string', 'array', 'set', 'file'].includes(issue.origin)
        ? 'TOO_SHORT'
        : 'OUT_OF_RANGE';
    case 'too_big':
      return ['string', 'array', 'set', 'file'].includes(issue.origin)
        ? 'TOO_LONG'
        : 'OUT_OF_RANGE';
    default:
      return 'INVALID_FORMAT';
  }
}

function toFieldErrors(prefix: string, issues: readonly ZodIssue[]): FieldError[] {
  const errors: FieldError[] = [];
  for (const issue of issues) {
    const base = [prefix, ...issue.path.map(String)];
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys)
        errors.push({ path: [...base, key].join('.'), code: 'UNKNOWN_FIELD' });
    } else {
      errors.push({ path: base.join('.'), code: fieldCode(issue) });
    }
  }
  // One detail per field: the first failure reported for it.
  const seen = new Set<string>();
  return errors.filter((e) => !seen.has(e.path) && seen.add(e.path));
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

/**
 * Validates path, query and body against the route's schemas before the handler runs.
 * Any failure is 400 VALIDATION_FAILED with field details; parsed values replace req.body
 * and are available as res.locals.input.
 */
export function validateRequest(route: RouteDefinition): RequestHandler {
  return (req, res, next) => {
    const details: FieldError[] = [];
    const input: Record<string, unknown> = {};
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
      else details.push(...toFieldErrors(prefix, result.error.issues));
    }
    if (details.length > 0) {
      next(new AppError('VALIDATION_FAILED', { details }));
      return;
    }
    req.body = input['body'];
    res.locals['input'] = input;
    next();
  };
}
