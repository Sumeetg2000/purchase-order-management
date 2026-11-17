import { z } from 'zod';
import {
  carriesOrderState,
  carriesRevokeReason,
  clashMemberOf,
  ERROR_CODES,
  FIELD_CODES,
  isErrorCode,
} from '../errors.js';
import { ORDER_ACTIONS, ORDER_STATUSES } from '../orders.js';
import { PUBLIC_REVOKE_REASONS } from '../sessions.js';
import { extensibleEnum } from './extensible-enum.js';

export const errorCodeSchema = z.enum(ERROR_CODES as [string, ...string[]]).meta({
  id: 'ErrorCode',
  description: 'Every code in the registry (packages/contracts/src/errors.ts).',
  ...extensibleEnum,
});

export const fieldErrorSchema = z
  .strictObject({
    path: z.string(),
    code: z.enum(FIELD_CODES).meta(extensibleEnum),
  })
  .meta({ id: 'FieldError' });

/** RFC 9457 problem document, as every API error response carries it (ADR-0007). */
export const problemSchema = z
  .strictObject({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    code: errorCodeSchema,
    correlationId: z.string(),
    details: z.array(fieldErrorSchema).optional(),
    /** Why the session was revoked: SESSION_REVOKED only, and only a public reason. */
    reason: z.enum(PUBLIC_REVOKE_REASONS).optional(),
    existingVendor: z
      .strictObject({ id: z.uuid(), name: z.string() })
      .optional()
      .meta({ description: 'The vendor whose name clashed: DUPLICATE_VENDOR_NAME only.' }),
    orderState: z
      .strictObject({
        status: z.enum(ORDER_STATUSES),
        action: z.enum(ORDER_ACTIONS).optional(),
      })
      .optional()
      .meta({
        description:
          "The order's status, and the action refused: ORDER_LOCKED, ORDER_PENDING_APPROVAL and INVALID_STATE_TRANSITION on orders.",
      }),
  })
  .refine(
    (problem) =>
      problem.reason === undefined ||
      (isErrorCode(problem.code) && carriesRevokeReason(problem.code)),
    { path: ['reason'], message: 'only SESSION_REVOKED carries a reason' },
  )
  .refine(
    (problem) =>
      problem.existingVendor === undefined ||
      (isErrorCode(problem.code) && clashMemberOf(problem.code) === 'existingVendor'),
    { path: ['existingVendor'], message: 'only DUPLICATE_VENDOR_NAME carries existingVendor' },
  )
  .refine(
    (problem) =>
      problem.orderState === undefined ||
      (isErrorCode(problem.code) && carriesOrderState(problem.code)),
    { path: ['orderState'], message: 'only the order state codes carry orderState' },
  )
  .meta({ id: 'Problem' });

export type Problem = z.infer<typeof problemSchema>;
