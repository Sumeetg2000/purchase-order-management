import { z } from 'zod';
import { carriesRevokeReason, ERROR_CODES, FIELD_CODES, isErrorCode } from '../errors.js';
import { PUBLIC_REVOKE_REASONS } from '../sessions.js';

/**
 * Publishes a Zod enum as `x-extensible-enum` instead of `enum`. Error and field codes
 * grow with every slice, and clients must handle a code they don't know (the web app
 * shows the internal-error message), so a new code is not a breaking change (ADR-0008,
 * amended 2026-11-03). Validation in code still accepts only the listed values.
 */
const extensibleEnum = {
  override: ({ jsonSchema }: { jsonSchema: Record<string, unknown> }) => {
    jsonSchema['x-extensible-enum'] = jsonSchema['enum'];
    delete jsonSchema['enum'];
  },
};

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
  })
  .refine(
    (problem) =>
      problem.reason === undefined ||
      (isErrorCode(problem.code) && carriesRevokeReason(problem.code)),
    { path: ['reason'], message: 'only SESSION_REVOKED carries a reason' },
  )
  .meta({ id: 'Problem' });

export type Problem = z.infer<typeof problemSchema>;
