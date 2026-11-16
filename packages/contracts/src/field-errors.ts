import type { z } from 'zod';
import { isFieldCode, type FieldCode, type FieldError } from './errors.js';

// Zod issue → field error (ADR-0007): the one mapping the API answers with, shared with the
// contract tests so they check exactly what a client gets. Codes and origins only, never
// message text.

type ZodIssue = z.core.$ZodIssue;

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
    case 'custom': {
      // A schema's own rule names its field code (slice 1 research R4), e.g.
      // PASSWORD_TOO_SHORT, or READ_ONLY_FIELD from readOnlyGuarded.
      const named: unknown = issue.params?.['fieldCode'];
      return isFieldCode(named) ? named : 'INVALID_FORMAT';
    }
    default:
      return 'INVALID_FORMAT';
  }
}

/**
 * One field error per field, under `prefix` (path, query, body): the first failure
 * reported for it, except that a read-only field is READ_ONLY_FIELD even though the strict
 * object also reports it as unknown (ADR-0003: the specific code wins).
 */
export function fieldErrors(prefix: string, issues: readonly ZodIssue[]): FieldError[] {
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
  const readOnly = new Set(errors.filter((e) => e.code === 'READ_ONLY_FIELD').map((e) => e.path));
  const seen = new Set<string>();
  return errors.filter((e) => {
    if (readOnly.has(e.path) && e.code !== 'READ_ONLY_FIELD') return false;
    if (seen.has(e.path)) return false;
    seen.add(e.path);
    return true;
  });
}
