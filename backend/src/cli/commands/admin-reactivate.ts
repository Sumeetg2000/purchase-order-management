import type { AuditedTransaction } from '../../db/transaction.js';
import { setAdminStatus } from '../../users/admin-status.js';
import { parseEmailArg } from './email-arg.js';

// admin:reactivate --email <email> (contracts/cli.md). Reactivates a deactivated
// administrator; they log in with the password they had.

export const USAGE_LINE = 'admin:reactivate --email <email>';

export interface AdminReactivateArgs {
  email: string;
}

export function parseAdminReactivateArgs(argv: readonly string[]): AdminReactivateArgs {
  return { email: parseEmailArg(argv, USAGE_LINE) };
}

/** Runs inside the CLI's OPERATOR transaction; returns the lines to print. */
export async function adminReactivate(
  tx: AuditedTransaction,
  args: AdminReactivateArgs,
  now: Date,
): Promise<string[]> {
  const result = await setAdminStatus(tx, { email: args.email, status: 'ACTIVE', now });
  return [
    result.changed
      ? `Admin reactivated: ${result.email}`
      : `Admin already active: ${result.email}; nothing changed`,
  ];
}
