import { z } from 'zod';

// Derived and system-assigned fields in a request body (ADR-0003): refused, never ignored,
// and with their own field code, READ_ONLY_FIELD, so a client sending `total` learns that
// the server computes it. The schema stays a strict object (the OpenAPI document, the body
// inventory and the strictness check read it as one). The strict object reports every
// extra key as unrecognized and drops it from the parsed value, so this check reads the
// keys from that issue, runs even though the object failed, and adds READ_ONLY_FIELD for
// the listed ones; fieldErrors then lets it win over UNKNOWN_FIELD for the same key.

export function readOnlyGuarded<T extends z.ZodObject>(
  schema: T,
  readOnlyFields: readonly string[],
): T {
  const listed = new Set(readOnlyFields);
  return schema.check(
    z.superRefine(
      (_value, ctx) => {
        const extra = ctx.issues.flatMap((issue) =>
          issue.code === 'unrecognized_keys' && (issue.path ?? []).length === 0 ? issue.keys : [],
        );
        for (const key of extra.filter((k) => listed.has(k))) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            input: undefined,
            params: { fieldCode: 'READ_ONLY_FIELD' },
          });
        }
      },
      // Run although the object already failed: the unknown keys are what it checks.
      { when: () => true },
    ),
  );
}
