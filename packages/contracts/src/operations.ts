import { z } from 'zod';
import type { ErrorCode } from './errors.js';
import { loginBody, resetPasswordBody } from './schemas/auth.js';
import { healthSchema, readinessSchema } from './schemas/health.js';
import { me } from './schemas/me.js';

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
  /** Its success response sets (or clears) the session cookies (ADR-0017). */
  setsCookies?: true;
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

  // Slice 1, US1: sessions (ADR-0017, contracts/api.md).
  login: {
    method: 'post',
    path: '/auth/login',
    operationId: 'login',
    summary: 'Log in with email and password; sets the session cookies.',
    access: 'public',
    setsCookies: true,
    request: { body: loginBody },
    responses: { 200: me },
    errors: [
      'ACCOUNT_NOT_FOUND',
      'ACCOUNT_LOCKED',
      'PASSWORD_NOT_SET',
      'INCORRECT_PASSWORD',
      'ACCOUNT_NOT_VERIFIED',
      'ACCOUNT_DEACTIVATED',
      'RATE_LIMITED',
    ],
  },
  refreshSession: {
    method: 'post',
    path: '/auth/refresh',
    operationId: 'refreshSession',
    summary: 'Rotate the refresh token and issue a new access token.',
    access: 'refresh',
    setsCookies: true,
    responses: { 204: z.void() },
    errors: ['SESSION_REVOKED', 'ACCOUNT_DEACTIVATED'],
  },
  logout: {
    method: 'post',
    path: '/auth/logout',
    operationId: 'logout',
    summary: "End this browser's session and clear its cookies.",
    access: 'refresh',
    setsCookies: true,
    responses: { 204: z.void() },
    errors: ['SESSION_REVOKED'],
  },
  logoutAll: {
    method: 'post',
    path: '/auth/logout-all',
    operationId: 'logoutAll',
    summary: "End every one of the user's sessions and clear this browser's cookies.",
    access: 'refresh',
    setsCookies: true,
    responses: { 204: z.void() },
    errors: ['SESSION_REVOKED'],
  },
  resetPassword: {
    method: 'post',
    path: '/auth/reset-password',
    operationId: 'resetPassword',
    summary: 'Set a new password from a reset or set-password link.',
    access: 'public',
    request: { body: resetPasswordBody },
    responses: { 204: z.void() },
    errors: ['TOKEN_EXPIRED', 'TOKEN_USED', 'TOKEN_SUPERSEDED', 'INVALID_TOKEN'],
  },
  getMe: {
    method: 'get',
    path: '/me',
    operationId: 'getMe',
    summary: "The caller's own profile.",
    access: 'user',
    responses: { 200: me },
  },
} as const satisfies Record<string, OperationContract>;
