import { z } from 'zod';
import { ERROR_CODES, FIELD_CODES } from '../errors.js';

export const errorCodeSchema = z.enum(ERROR_CODES as [string, ...string[]]).meta({
  id: 'ErrorCode',
  description: 'Every code in the registry (packages/contracts/src/errors.ts).',
});

export const fieldErrorSchema = z
  .strictObject({
    path: z.string(),
    code: z.enum(FIELD_CODES),
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
  })
  .meta({ id: 'Problem' });

export type Problem = z.infer<typeof problemSchema>;
