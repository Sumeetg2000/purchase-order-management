// Stable error codes of the operator-facing processes: the CLI prints them as
// `ERROR <CODE>: ...` and the bootstrap fails migrate with them (contracts/cli.md, which a
// test keeps in step with this list). Outside cli/ so shared code (users/create-admin.ts)
// can use them without reaching CLI modules.

export const CLI_ERROR_CODES = [
  'USAGE',
  'INVALID_ARGUMENT',
  'INVALID_CONFIGURATION',
  'BOOTSTRAP_SETTINGS_MISSING',
  'EMAIL_IN_USE',
  'UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];
