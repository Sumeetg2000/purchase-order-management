import { emailAddressSchema } from '@po/contracts';
import { parseArgs } from 'node:util';
import { CliError, EXIT } from '../errors.js';

// The single `--email <email>` flag of admin:deactivate and admin:reactivate.

/** Flags → the lower-cased email; throws CliError USAGE or INVALID_ARGUMENT. */
export function parseEmailArg(argv: readonly string[], usageLine: string): string {
  let email: string | undefined;
  try {
    ({
      values: { email },
    } = parseArgs({
      args: [...argv],
      options: { email: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    // util.parseArgs reports by code, e.g. ERR_PARSE_ARGS_UNKNOWN_OPTION.
    const code = (error as { code?: unknown }).code;
    throw new CliError(
      'USAGE',
      EXIT.USAGE,
      `unknown or malformed flag (${typeof code === 'string' ? code : 'parse error'}). Usage: ${usageLine}`,
    );
  }
  if (email === undefined) {
    throw new CliError('USAGE', EXIT.USAGE, `--email is required. Usage: ${usageLine}`);
  }
  const parsed = emailAddressSchema.safeParse(email);
  if (!parsed.success) {
    // The reason only; the value is not echoed.
    const reason = parsed.error.issues[0]?.message ?? 'invalid';
    throw new CliError('INVALID_ARGUMENT', EXIT.USAGE, `--email: ${reason}`);
  }
  return parsed.data.toLowerCase();
}
