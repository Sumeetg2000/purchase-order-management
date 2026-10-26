import { z } from 'zod';
import { ERROR_CODES, FIELD_CODES } from '../errors.js';

export const fieldErrorSchema = z.strictObject({
  path: z.string(),
  code: z.enum(FIELD_CODES),
});

/** RFC 9457 problem document, as every API error response carries it (ADR-0007). */
export const problemSchema = z.strictObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: z.enum(ERROR_CODES as [string, ...string[]]),
  correlationId: z.string(),
  details: z.array(fieldErrorSchema).optional(),
});

export type Problem = z.infer<typeof problemSchema>;
