import type { z } from 'zod';
import type { ErrorCode } from './errors.js';
import { healthSchema, readinessSchema } from './schemas/health.js';

/**
 * Who may call an operation (Principle III, deny by default; research R1):
 * - public: anyone
 * - refresh: the holder of a refresh cookie (refresh, logout, logout-all)
 * - user: any logged-in user, with or without a role
 * - no-role: a logged-in user with no role (their own access request)
 * - admin: a logged-in Admin
 */
export const ACCESS_LEVELS = ['public', 'refresh', 'user', 'no-role', 'admin'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface OperationRequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

/**
 * One API operation as the contract states it (ADR-0008): the API binds a handler to it,
 * and the OpenAPI document is generated from it. Paths use Express syntax (`/items/:id`).
 */
export interface OperationContract {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  access: Access;
  /** A versioned update: the request must send `If-Match` with the ETag (ADR-0016). */
  ifMatch?: 'required';
  request?: OperationRequestSchemas;
  /** Success responses by status. */
  responses: Readonly<Record<number, z.ZodType>>;
  /** Codes this operation returns beyond the ones every operation can return. */
  errors?: readonly ErrorCode[];
}

/** Every operation of the API. The generator documents exactly these. */
export const OPERATIONS = {
  getHealth: {
    method: 'get',
    path: '/healthz',
    operationId: 'getHealth',
    summary: 'Liveness. The process is up and serving.',
    access: 'public',
    responses: { 200: healthSchema },
  },
  getReadiness: {
    method: 'get',
    path: '/readyz',
    operationId: 'getReadiness',
    summary: 'Readiness. The database is reachable and migrations are complete.',
    access: 'public',
    responses: { 200: readinessSchema },
    errors: ['SERVICE_UNAVAILABLE'],
  },
} as const satisfies Record<string, OperationContract>;
