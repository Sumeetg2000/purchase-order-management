import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';

/**
 * Who may call a route (Principle III, deny by default). Slice 0 has only public health
 * routes; slice 1 adds the authenticated levels.
 */
export const ACCESS_LEVELS = ['public'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteRequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

/**
 * The single way to register an HTTP route. The same definition feeds the startup checks
 * and the OpenAPI document (ADR-0008), so an undeclared or undocumented route cannot
 * exist. Request validation against these schemas is wired in by the error middleware
 * (US3).
 */
export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  access: Access;
  request?: RouteRequestSchemas;
  responses: Readonly<Record<number, z.ZodType>>;
  handler: (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
}

export function defineRoute<const R extends RouteDefinition>(route: R): R {
  return route;
}
