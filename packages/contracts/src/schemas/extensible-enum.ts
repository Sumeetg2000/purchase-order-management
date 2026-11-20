/**
 * Publishes a Zod enum as `x-extensible-enum` instead of `enum`. Error and field codes, and
 * the order timeline's actions, grow with every slice, and clients must handle a value they
 * don't know (the web app shows the internal-error message for a code), so a new one is not
 * a breaking change (ADR-0008, amended 2026-11-03). Validation in code still accepts only
 * the listed values.
 */
export const extensibleEnum = {
  override: ({ jsonSchema }: { jsonSchema: Record<string, unknown> }) => {
    jsonSchema['x-extensible-enum'] = jsonSchema['enum'];
    delete jsonSchema['enum'];
  },
};
