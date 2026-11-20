import { MONEY_SCALE, toMoney, type Money } from '@po/contracts';
import { parseArgs } from 'node:util';
import { setApprovalPolicy } from '../../approvals/policy.js';
import type { AuditedTransaction } from '../../db/transaction.js';
import { CliError, EXIT } from '../errors.js';

// policy:set --tier1 <amount> (ADR-0002, research R1). A new policy version, effective for
// the next submission; orders already submitted keep theirs. One tier today: repeated
// --tier flags are a CLI change only, as set_approval_policy takes an array.

export const USAGE_LINE = 'policy:set --tier1 <amount>';

/** A decimal amount: digits, at most 4 decimal places, within numeric(22,4). */
const AMOUNT = new RegExp(`^\\d{1,18}(\\.\\d{1,${String(MONEY_SCALE)}})?$`);

interface PolicySetArgs {
  thresholds: Money[];
}

/** Flags → validated thresholds; throws CliError USAGE or INVALID_ARGUMENT. */
export function parsePolicySetArgs(argv: readonly string[]): PolicySetArgs {
  let tier1: string | undefined;
  try {
    ({
      values: { tier1 },
    } = parseArgs({
      args: [...argv],
      options: { tier1: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new CliError(
      'USAGE',
      EXIT.USAGE,
      `unknown or malformed flag (${typeof code === 'string' ? code : 'parse error'}). Usage: ${USAGE_LINE}`,
    );
  }
  if (tier1 === undefined) {
    throw new CliError('USAGE', EXIT.USAGE, `--tier1 is required. Usage: ${USAGE_LINE}`);
  }
  // The value is not echoed (contracts/cli.md).
  const threshold = AMOUNT.test(tier1) ? toMoney(tier1) : undefined;
  if (threshold === undefined || /^0+\.0+$/.test(threshold)) {
    throw new CliError(
      'INVALID_ARGUMENT',
      EXIT.USAGE,
      `--tier1: a decimal amount greater than 0, at most ${String(MONEY_SCALE)} decimal places`,
    );
  }
  return { thresholds: [threshold] };
}

/** Runs inside the CLI's OPERATOR transaction; returns the lines to print. */
export async function policySet(tx: AuditedTransaction, args: PolicySetArgs): Promise<string[]> {
  const result = await setApprovalPolicy(tx, args.thresholds);
  const tiers = result.policy.tiers
    .map((t) => `tier ${String(t.tier)} above ${t.threshold}`)
    .join(', ');
  const version = String(result.policy.version);
  return result.changed
    ? [`Approval policy set: version ${version}, ${tiers}`]
    : [`Approval policy unchanged: version ${version} already has ${tiers}`];
}
