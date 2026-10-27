import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { AuditedTransaction } from '../../db/transaction.js';
import { createAdmin } from '../../users/create-admin.js';
import { CliError, EXIT } from '../errors.js';

// admin:create --email <email> --name <name> (contracts/cli.md). Creates an ACTIVE
// administrator with no password and prints a one-time set-password link.

export const USAGE_LINE = 'admin:create --email <email> --name <name>';

const argsSchema = z.strictObject({
  email: z.email().transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(100),
});

export type AdminCreateArgs = z.output<typeof argsSchema>;

/** Flags → validated arguments; throws CliError USAGE or INVALID_ARGUMENT. */
export function parseAdminCreateArgs(argv: readonly string[]): AdminCreateArgs {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { email: { type: 'string' }, name: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    // util.parseArgs reports by code, e.g. ERR_PARSE_ARGS_UNKNOWN_OPTION.
    const code = (error as { code?: unknown }).code;
    throw new CliError(
      'USAGE',
      EXIT.USAGE,
      `unknown or malformed flag (${typeof code === 'string' ? code : 'parse error'}). Usage: ${USAGE_LINE}`,
    );
  }
  if (values['email'] === undefined || values['name'] === undefined) {
    throw new CliError(
      'USAGE',
      EXIT.USAGE,
      `--email and --name are required. Usage: ${USAGE_LINE}`,
    );
  }
  const parsed = argsSchema.safeParse(values);
  if (!parsed.success) {
    // Field names and reasons only; the values are not echoed.
    const fields = parsed.error.issues.map(
      (issue) => `--${issue.path.join('.')}: ${issue.message}`,
    );
    throw new CliError('INVALID_ARGUMENT', EXIT.USAGE, fields.join('; '));
  }
  return parsed.data;
}

/** Runs inside the CLI's OPERATOR transaction; returns the lines to print. */
export async function adminCreate(
  tx: AuditedTransaction,
  args: AdminCreateArgs,
  appOrigin: string,
): Promise<string[]> {
  const { email, link } = await createAdmin(tx, { ...args, source: 'cli', appOrigin });
  return [
    `Admin created: ${email}`,
    'One-time set-password link (valid 30 minutes, shown once):',
    link,
  ];
}
