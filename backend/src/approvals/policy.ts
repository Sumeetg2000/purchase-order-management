import { toMoney, type Money } from '@po/contracts';
import type { AuditPolicy } from '../audit/events.js';
import { writeAudit } from '../audit/write.js';
import { lockApprovalPolicy } from '../db/locks.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { callSetApprovalPolicy, selectCurrentPolicy } from './repository.js';

// The approval policy as the operator CLI reads and changes it (ADR-0002, research R1).
// Only the CLI's OPERATOR transaction reaches set_approval_policy; no HTTP route does.

/** The current policy version, its tiers and when it took effect. */
export interface CurrentPolicy extends AuditPolicy {
  effectiveAt: Date;
}

export async function currentPolicy(tx: AuditedTransaction): Promise<CurrentPolicy> {
  const row = await selectCurrentPolicy(tx);
  return {
    version: row.version,
    effectiveAt: row.effectiveAt,
    tiers: row.tiers.map((t) => ({ tier: t.tier, threshold: toMoney(t.threshold) })),
  };
}

export type PolicyChange =
  | { changed: false; policy: CurrentPolicy }
  | { changed: true; before: CurrentPolicy; policy: CurrentPolicy };

/**
 * Sets the policy's thresholds, tier 1 first. Under APPROVAL_POLICY_LOCK, exclusive: a
 * submit in progress finishes first, and none starts routing until this commits. The
 * current tiers again are a no-op; a new version is audited APPROVAL_POLICY_CHANGED.
 */
export async function setApprovalPolicy(
  tx: AuditedTransaction,
  thresholds: readonly Money[],
): Promise<PolicyChange> {
  await lockApprovalPolicy(tx);
  const before = await currentPolicy(tx);
  const version = await callSetApprovalPolicy(tx, thresholds);
  if (version === before.version) return { changed: false, policy: before };
  const policy = await currentPolicy(tx);
  await writeAudit(tx, {
    action: 'APPROVAL_POLICY_CHANGED',
    entityType: 'approval_policy',
    entityId: String(policy.version),
    details: { before: auditPolicy(before), after: auditPolicy(policy) },
  });
  return { changed: true, before, policy };
}

function auditPolicy({ version, tiers }: CurrentPolicy): AuditPolicy {
  return { version, tiers };
}
