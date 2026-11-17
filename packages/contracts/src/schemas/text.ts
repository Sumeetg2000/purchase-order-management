import { z } from 'zod';
import { PO_NUMBER_PREFIX_MAX } from '../orders.js';

// Text fields shared by the order and approval schemas (slice 3 research R9). Not
// re-exported from the package index: only the schemas built from them are public.

/**
 * Length in Unicode code points: an emoji counts once, not as two UTF-16 units. That is
 * the UTF-16 length less one per surrogate pair, as PostgreSQL's char_length counts.
 */
const codePoints = (s: string) => s.length - (s.match(SURROGATE_PAIR)?.length ?? 0);
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/**
 * Well-formed Unicode: no lone surrogate (an escaped JSON string can carry one, and
 * PostgreSQL can't store it). With the u flag a surrogate pair is one code point, so this
 * class matches only an unpaired half. String.prototype.isWellFormed is ES2024.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Trimmed, well-formed text of 1 to `max` code points; `allowed` control characters only. */
export function plainText(max: number, allowedControls: RegExp | undefined) {
  return z
    .string()
    .trim()
    .refine((s) => !LONE_SURROGATE.test(s), { params: { fieldCode: 'INVALID_FORMAT' } })
    .refine((s) => !/\p{Cc}/u.test(allowedControls ? s.replace(allowedControls, '') : s), {
      params: { fieldCode: 'INVALID_FORMAT' },
    })
    .refine((s) => codePoints(s) >= 1, { params: { fieldCode: 'TOO_SHORT' } })
    .refine((s) => codePoints(s) <= max, { params: { fieldCode: 'TOO_LONG' } });
}

/** A PO-number prefix, case-insensitive: upper-cased before matching (slice 3 research R7). */
export const poNumberPrefix = z
  .string()
  .trim()
  .min(1)
  .max(PO_NUMBER_PREFIX_MAX)
  .regex(/^[A-Za-z0-9-]+$/)
  .transform((s) => s.toUpperCase());
