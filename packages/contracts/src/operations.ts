import { z } from 'zod';
import type { ErrorCode } from './errors.js';
import {
  accessRequestBody,
  accessRequestListQuery,
  adminAccessRequest,
  dismissBody,
  ownAccessRequest,
} from './schemas/access-requests.js';
import {
  adminUserDetail,
  adminUserItem,
  updateUserBody,
  userListQuery,
} from './schemas/admin-users.js';
import { emailBody, loginBody, resetPasswordBody, signupBody, tokenBody } from './schemas/auth.js';
import { healthSchema, readinessSchema } from './schemas/health.js';
import { idParams } from './schemas/ids.js';
import { me } from './schemas/me.js';
import { pageOf } from './schemas/pagination.js';

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
  /** Its success response carries the resource's version as `ETag` (ADR-0016). */
  etag?: true;
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
    summary: "End this browser's session, whatever its state, and clear its cookies.",
    access: 'refresh',
    setsCookies: true,
    responses: { 204: z.void() },
  },
  logoutAll: {
    method: 'post',
    path: '/auth/logout-all',
    operationId: 'logoutAll',
    summary: "End every one of the user's sessions and clear this browser's cookies.",
    access: 'refresh',
    setsCookies: true,
    responses: { 204: z.void() },
  },
  resetPassword: {
    method: 'post',
    path: '/auth/reset-password',
    operationId: 'resetPassword',
    summary: 'Set a new password from a reset or set-password link.',
    access: 'public',
    request: { body: resetPasswordBody },
    responses: { 204: z.void() },
    errors: [
      'TOKEN_EXPIRED',
      'TOKEN_USED',
      'TOKEN_SUPERSEDED',
      'INVALID_TOKEN',
      'ACCOUNT_DEACTIVATED',
    ],
  },
  getMe: {
    method: 'get',
    path: '/me',
    operationId: 'getMe',
    summary: "The caller's own profile.",
    access: 'user',
    responses: { 200: me },
  },

  // Slice 1, US2: signup, verification and the access request (ADR-0016, ADR-0017).
  signup: {
    method: 'post',
    path: '/auth/signup',
    operationId: 'signup',
    summary: 'Create an unverified account with no role, and email a verification link.',
    access: 'public',
    request: { body: signupBody },
    responses: { 202: z.void() },
    errors: ['SIGNUP_DOMAIN_NOT_ALLOWED', 'EMAIL_IN_USE', 'RATE_LIMITED'],
  },
  verifyEmail: {
    method: 'post',
    path: '/auth/verify-email',
    operationId: 'verifyEmail',
    summary: "Activate an account from its verification link; doesn't log in.",
    access: 'public',
    request: { body: tokenBody },
    responses: { 204: z.void() },
    errors: [
      'TOKEN_EXPIRED',
      'TOKEN_USED',
      'TOKEN_SUPERSEDED',
      'INVALID_TOKEN',
      'ACCOUNT_DEACTIVATED',
    ],
  },
  resendVerification: {
    method: 'post',
    path: '/auth/resend-verification',
    operationId: 'resendVerification',
    summary: 'Email a new verification link; the earlier one stops working.',
    access: 'public',
    request: { body: emailBody },
    responses: { 202: z.void() },
    errors: [
      'ACCOUNT_NOT_FOUND',
      'ACCOUNT_ALREADY_VERIFIED',
      'ACCOUNT_DEACTIVATED',
      'RATE_LIMITED',
    ],
  },
  getOwnAccessRequest: {
    method: 'get',
    path: '/me/access-request',
    operationId: 'getOwnAccessRequest',
    summary: "The caller's latest access request; 404 if they never sent one.",
    access: 'no-role',
    responses: { 200: ownAccessRequest },
    errors: ['NOT_FOUND'],
  },
  sendAccessRequest: {
    method: 'post',
    path: '/me/access-request',
    operationId: 'sendAccessRequest',
    summary: 'Ask for a role: opens a request, or updates the open one.',
    access: 'no-role',
    request: { body: accessRequestBody },
    responses: { 200: ownAccessRequest },
    errors: ['RATE_LIMITED'],
  },

  // Slice 1, US3: user administration and access requests (ADR-0016).
  listUsers: {
    method: 'get',
    path: '/admin/users',
    operationId: 'listUsers',
    summary: 'Users, filtered by role, status and a name or email prefix, by name then id.',
    access: 'admin',
    request: { query: userListQuery },
    responses: { 200: pageOf(adminUserItem) },
  },
  getUser: {
    method: 'get',
    path: '/admin/users/:id',
    operationId: 'getUser',
    summary: 'One user, with their version.',
    access: 'admin',
    etag: true,
    request: { params: idParams },
    responses: { 200: adminUserDetail },
    errors: ['NOT_FOUND'],
  },
  updateUser: {
    method: 'patch',
    path: '/admin/users/:id',
    operationId: 'updateUser',
    summary: "Change a user's role set or activation; their sessions end.",
    access: 'admin',
    ifMatch: 'required',
    etag: true,
    request: { params: idParams, body: updateUserBody },
    responses: { 200: adminUserDetail },
    errors: [
      'NOT_FOUND',
      'SELF_MODIFICATION',
      'ADMIN_NOT_MODIFIABLE',
      'USER_UNVERIFIED',
      'VERSION_CONFLICT',
    ],
  },
  sendUserPasswordReset: {
    method: 'post',
    path: '/admin/users/:id/reset-password',
    operationId: 'sendUserPasswordReset',
    summary: 'Email the user the standard password reset link.',
    access: 'admin',
    request: { params: idParams },
    responses: { 202: z.void() },
    errors: ['NOT_FOUND', 'SELF_MODIFICATION', 'ADMIN_NOT_MODIFIABLE', 'USER_DEACTIVATED'],
  },
  listAccessRequests: {
    method: 'get',
    path: '/admin/access-requests',
    operationId: 'listAccessRequests',
    summary: 'Access requests, optionally by status, newest activity first.',
    access: 'admin',
    request: { query: accessRequestListQuery },
    responses: { 200: pageOf(adminAccessRequest) },
  },
  dismissAccessRequest: {
    method: 'post',
    path: '/admin/access-requests/:id/dismiss',
    operationId: 'dismissAccessRequest',
    summary: 'Dismiss an open access request, with an optional note for the user.',
    access: 'admin',
    request: { params: idParams, body: dismissBody },
    responses: { 200: adminAccessRequest },
    errors: ['NOT_FOUND', 'ACCESS_REQUEST_NOT_OPEN'],
  },
} as const satisfies Record<string, OperationContract>;
