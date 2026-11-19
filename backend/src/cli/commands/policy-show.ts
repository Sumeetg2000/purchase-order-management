import { parseArgs } from 'node:util';
import { currentPolicy } from '../../approvals/policy.js';
import type { AuditedTransaction } from '../../db/transaction.js';
import { CliError, EXIT } from '../errors.js';

// policy:show (ADR-0002): the current policy version, its tiers and when it took effect.

export const USAGE_LINE = 'policy:show';

export function parsePolicyShowArgs(argv: readonly string[]): void {
  try {
    parseArgs({ args: [...argv], options: {}, strict: true, allowPositionals: false });
  } catch {
    throw new CliError('USAGE', EXIT.USAGE, `policy:show takes no flags. Usage: ${USAGE_LINE}`);
  }
}

/** Runs inside the CLI's OPERATOR transaction; reads only. Returns the lines to print. */
export async function policyShow(tx: AuditedTransaction): Promise<string[]> {
  const policy = await currentPolicy(tx);
  return [
    `Approval policy version ${String(policy.version)}, effective ${policy.effectiveAt.toISOString()}`,
    ...policy.tiers.map((t) => `  tier ${String(t.tier)}: above ${t.threshold}`),
  ];
}
