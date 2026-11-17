import type { VendorOrderSnapshot } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import type { AuditedTransaction } from '../db/transaction.js';

// Approval rounds, steps and the policy (specs/005-submit-approve/data-model.md). Routing
// is SQL's (research R3): the steps come from the policy tiers the round's own total
// exceeds, compared as numeric. The database re-derives the chain at commit (D1).

/** The round a submit opened. Money as text. */
export interface OpenedRound {
  round: number;
  policyVersion: number;
  total: string;
  submittedAt: Date;
}

/** A step of a round as the submit created it. */
export interface CreatedStep {
  step: number;
  tier: number;
  threshold: string;
}

/**
 * Opens the order's next round under the highest policy version, with the order's total
 * and the vendor as submitted. The caller holds the order's and the vendor's locks; the
 * policy lock is taken last.
 */
export async function insertRound(
  tx: AuditedTransaction,
  orderId: string,
  snapshot: VendorOrderSnapshot,
): Promise<OpenedRound> {
  // Shared with every submit, exclusive in set_approval_policy: a policy change in
  // progress finishes first, so this statement and the round's guard read the same
  // highest version (research R3, ADR-0006).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('approval_policies'))`;
  const [row] = await tx.$queryRaw<OpenedRound[]>`
    INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot,
                                 submitted_by)
    SELECT o.id, coalesce(o.current_round, 0) + 1,
           (SELECT max(version) FROM approval_policies), o.total,
           ${JSON.stringify(snapshot)}::jsonb, o.owner_id
      FROM purchase_orders o WHERE o.id = ${orderId}::uuid
    RETURNING round::int AS round, policy_version AS "policyVersion", total::text AS total,
              submitted_at AS "submittedAt"`;
  if (!row) throw new Error(`order ${orderId} vanished under its lock`);
  return row;
}

/** One open step per tier the round's total strictly exceeds, ascending (ADR-0002). */
export async function insertSteps(
  tx: AuditedTransaction,
  orderId: string,
  round: number,
): Promise<CreatedStep[]> {
  const rows = await tx.$queryRaw<CreatedStep[]>`
    INSERT INTO approval_steps (order_id, round, step, tier, threshold)
    SELECT r.order_id, r.round, row_number() OVER (ORDER BY t.tier), t.tier, t.threshold
      FROM approval_rounds r
      JOIN approval_policy_tiers t
        ON t.policy_version = r.policy_version AND t.threshold < r.total
     WHERE r.order_id = ${orderId}::uuid AND r.round = ${round}
    RETURNING step::int AS step, tier::int AS tier, threshold::text AS threshold`;
  return rows.sort((a, b) => a.step - b.step);
}

/** T5: the order waits for approval, its submission the round's. */
export async function moveToPending(
  tx: AuditedTransaction,
  orderId: string,
  round: number,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE purchase_orders o
       SET status = 'PENDING_APPROVAL', current_round = r.round, submitted_at = r.submitted_at,
           version = o.version + 1
      FROM approval_rounds r
     WHERE o.id = ${orderId}::uuid AND r.order_id = o.id AND r.round = ${round}`;
}

/** T4: the round closes AUTO_APPROVED (as SYSTEM, the caller's job) and the order is approved. */
export async function autoApprove(
  tx: AuditedTransaction,
  orderId: string,
  round: number,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE approval_rounds SET outcome = 'AUTO_APPROVED', closed_at = now()
     WHERE order_id = ${orderId}::uuid AND round = ${round}`;
  await tx.$executeRaw`
    UPDATE purchase_orders o
       SET status = 'APPROVED', current_round = r.round, submitted_at = r.submitted_at,
           approved_at = r.closed_at, version = o.version + 1
      FROM approval_rounds r
     WHERE o.id = ${orderId}::uuid AND r.order_id = o.id AND r.round = ${round}`;
}

/** The lowest tier's threshold of a policy version: what an auto-approval was at or below. */
export async function lowestThreshold(
  tx: AuditedTransaction,
  policyVersion: number,
): Promise<string> {
  const [row] = await tx.$queryRaw<{ threshold: string }[]>`
    SELECT threshold::text AS threshold FROM approval_policy_tiers
     WHERE policy_version = ${policyVersion} ORDER BY tier LIMIT 1`;
  if (!row) throw new Error(`policy ${String(policyVersion)} has no tier`);
  return row.threshold;
}

/** The current policy: the highest version and its tiers, thresholds as text. */
export interface PolicyRow {
  version: number;
  effectiveAt: Date;
  tiers: { tier: number; threshold: string }[];
}

export async function selectCurrentPolicy(db: AppPrismaClient): Promise<PolicyRow> {
  const [row] = await db.$queryRaw<PolicyRow[]>`
    SELECT p.version, p.effective_at AS "effectiveAt",
           (SELECT json_agg(json_build_object('tier', t.tier, 'threshold', t.threshold::text)
                            ORDER BY t.tier)
              FROM approval_policy_tiers t WHERE t.policy_version = p.version) AS tiers
      FROM approval_policies p
     ORDER BY p.version DESC
     LIMIT 1`;
  if (!row) throw new Error('no approval policy: migration 0014 seeds version 1');
  return row;
}
