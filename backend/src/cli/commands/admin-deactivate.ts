import type { AuditedTransaction } from '../../db/transaction.js';
import { setAdminStatus } from '../../users/admin-status.js';
import { parseEmailArg } from './email-arg.js';

// admin:deactivate --email <email> (contracts/cli.md). Deactivates an administrator and
// ends their sessions; refuses the last active one.

export const USAGE_LINE = 'admin:deactivate --email <email>';

export interface AdminDeactivateArgs {
  email: string;
}

export function parseAdminDeactivateArgs(argv: readonly string[]): AdminDeactivateArgs {
  return { email: parseEmailArg(argv, USAGE_LINE) };
}

/** Runs inside the CLI's OPERATOR transaction; returns the lines to print. */
export async function adminDeactivate(
  tx: AuditedTransaction,
  args: AdminDeactivateArgs,
  now: Date,
): Promise<string[]> {
  const result = await setAdminStatus(tx, { email: args.email, status: 'DEACTIVATED', now });
  if (!result.changed) return [`Admin already deactivated: ${result.email}; nothing changed`];
  const ended = result.sessionsRevoked === 1 ? 'session' : 'sessions';
  return [`Admin deactivated: ${result.email} (${String(result.sessionsRevoked)} ${ended} ended)`];
}
