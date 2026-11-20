import type { ApprovalStepState, UserRole, UserStatus, VendorOrderSnapshot } from '@po/contracts';
import { Prisma } from '../generated/prisma/client.js';
import type { AuditCancelledLine } from '../audit/events.js';
import type { PageArgs } from '../lib/pagination.js';
import { pageNumber } from '../orders/repository.js';
import type { AppPrismaClient } from '../db/client.js';
import { APPROVAL_POLICY_LOCK } from '../db/locks.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { MAX_CODE_POINT } from '../db/prefix-range.js';

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
  // APPROVAL_POLICY_LOCK: shared by every submit, exclusive in set_approval_policy. A
  // policy change in progress finishes first, so this statement and the round's guard
  // read the same highest version (research R3, ADR-0006).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${APPROVAL_POLICY_LOCK})`;
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

export async function selectCurrentPolicy(
  db: AppPrismaClient | AuditedTransaction,
): Promise<PolicyRow> {
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

/** Whether this user has ever submitted an order (any round, any outcome). */
export async function hasSubmitted(tx: AuditedTransaction, userId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM approval_rounds WHERE submitted_by = ${userId}::uuid) AS found`;
  return row?.found === true;
}

/**
 * Writes the policy through its only write path, set_approval_policy (migration 0014),
 * which needs the OPERATOR context. Returns the current version: new, or unchanged when
 * the tiers equal the current ones.
 */
export async function callSetApprovalPolicy(
  tx: AuditedTransaction,
  thresholds: readonly string[],
): Promise<number> {
  const [row] = await tx.$queryRaw<{ version: number }[]>`
    SELECT set_approval_policy(${[...thresholds]}::numeric[]) AS version`;
  if (!row) throw new Error('set_approval_policy returned no row');
  return row.version;
}

/** A step of the current round, locked for a decision. */
export interface LockedStep {
  step: number;
  tier: number;
  state: ApprovalStepState;
}

/** Locks the round's steps in step order (ADR-0006: after the order, before the vendor). */
export async function lockSteps(
  tx: AuditedTransaction,
  orderId: string,
  round: number,
): Promise<LockedStep[]> {
  return tx.$queryRaw<LockedStep[]>`
    SELECT step::int AS step, tier::int AS tier, state FROM approval_steps
     WHERE order_id = ${orderId}::uuid AND round = ${round}
     ORDER BY step FOR UPDATE`;
}

/** A user as the decision re-checks them under lock. */
export interface LockedUser {
  id: string;
  status: UserStatus;
  roles: UserRole[];
}

/**
 * Locks users rows FOR SHARE in id order, last in ADR-0006's lock order: an admin change
 * of either waits for the decision, or the decision sees it (research R6).
 */
export async function lockUsers(
  tx: AuditedTransaction,
  ids: readonly string[],
): Promise<Map<string, LockedUser>> {
  const rows = await tx.$queryRaw<LockedUser[]>`
    SELECT id::text, status, roles FROM users
     WHERE id = ANY(${[...new Set(ids)]}::uuid[])
     ORDER BY id FOR SHARE`;
  return new Map(rows.map((row) => [row.id, row]));
}

/** Approves one step as the acting user, bound to the version they saw. */
export async function approveStep(
  tx: AuditedTransaction,
  target: { orderId: string; round: number; step: number; approverId: string; version: number },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE approval_steps
       SET state = 'APPROVED', decided_by = ${target.approverId}::uuid, decided_at = now(),
           decided_version = ${target.version}
     WHERE order_id = ${target.orderId}::uuid AND round = ${target.round}
       AND step = ${target.step}`;
}

/** T7: the round closes APPROVED and the order is approved, its approval time the close. */
export async function approveRoundAndOrder(
  tx: AuditedTransaction,
  orderId: string,
  round: number,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE approval_rounds SET outcome = 'APPROVED', closed_at = now()
     WHERE order_id = ${orderId}::uuid AND round = ${round}`;
  await tx.$executeRaw`
    UPDATE purchase_orders o
       SET status = 'APPROVED', approved_at = r.closed_at, version = o.version + 1
      FROM approval_rounds r
     WHERE o.id = ${orderId}::uuid AND r.order_id = o.id AND r.round = ${round}`;
}

/** T6: a step decided, more remain; the order's version moves. */
export async function bumpOrderVersion(tx: AuditedTransaction, orderId: string): Promise<void> {
  await tx.$executeRaw`UPDATE purchase_orders SET version = version + 1 WHERE id = ${orderId}::uuid`;
}

export interface QueueFilter {
  vendorId?: string | undefined;
  /** Upper-cased by the contract. */
  poNumber?: string | undefined;
}

/** One queue row as SQL returns it: money and times as text. */
export interface QueueRow {
  id: string;
  poNumber: string;
  owner: { id: string; name: string };
  vendor: { id: string; name: string };
  total: string;
  submittedAt: string;
  currentStep: { step: number; tier: number; of: number };
  ownerCanAct: boolean;
  version: number;
}

/**
 * The approval queue (research R7): pending orders not the caller's, on the partial
 * indexes. The page picks its keys from the index, cut at LIMIT/OFFSET literals, then joins
 * back for its rows; rows and total come from one statement, one snapshot. Oldest
 * submission first, or by PO number, newest first, with a prefix.
 */
export function approvalQueueSql(
  callerId: string,
  filter: QueueFilter,
  { offset, limit }: PageArgs,
) {
  const conditions = [
    Prisma.sql`status = 'PENDING_APPROVAL'`,
    Prisma.sql`owner_id <> ${callerId}::uuid`,
  ];
  if (filter.vendorId !== undefined)
    conditions.push(Prisma.sql`vendor_id = ${filter.vendorId}::uuid`);
  const byPoNumber = filter.poNumber !== undefined;
  if (filter.poNumber !== undefined) {
    conditions.push(Prisma.sql`po_number >= ${filter.poNumber}
      AND po_number < ${filter.poNumber} || chr(${MAX_CODE_POINT}::int)`);
  }
  const where = Prisma.join(conditions, ' AND ');
  const order = (alias: string) =>
    byPoNumber
      ? Prisma.raw(`${alias}.po_number DESC`)
      : Prisma.raw(`${alias}.submitted_at, ${alias}.id`);
  const page = Prisma.sql`
    SELECT k.id FROM (SELECT id, po_number, submitted_at FROM purchase_orders WHERE ${where}
                       ORDER BY ${order('purchase_orders')}
                       LIMIT ${pageNumber(limit)} OFFSET ${pageNumber(offset)}) k`;
  const count = Prisma.sql`SELECT count(*) FROM purchase_orders WHERE ${where}`;
  const statement = Prisma.sql`
    SELECT (${count})::int AS total,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', o.id::text,
                      'poNumber', o.po_number,
                      'owner', json_build_object('id', u.id::text, 'name', u.name),
                      'vendor', json_build_object('id', o.vendor_id::text,
                                                  'name', r.vendor_snapshot ->> 'name'),
                      'total', o.total::text,
                      'submittedAt', o.submitted_at,
                      'currentStep', (SELECT json_build_object(
                                               'step', min(s.step) FILTER (WHERE s.state = 'OPEN'),
                                               'tier', min(s.tier) FILTER (WHERE s.state = 'OPEN'),
                                               'of', count(*))
                                        FROM approval_steps s
                                       WHERE s.order_id = o.id AND s.round = o.current_round),
                      'ownerCanAct', (u.status = 'ACTIVE' AND 'BUYER' = ANY (u.roles)),
                      'version', o.version)
                    ORDER BY ${order('o')})
               FROM (${page}) p
               JOIN purchase_orders o ON o.id = p.id
               JOIN users u ON u.id = o.owner_id
               JOIN approval_rounds r ON r.order_id = o.id AND r.round = o.current_round), '[]'::json)
             AS items`;
  return { statement, page, count };
}

export async function listApprovalQueue(
  db: AppPrismaClient,
  callerId: string,
  filter: QueueFilter,
  page: PageArgs,
): Promise<{ total: number; items: QueueRow[] }> {
  const [row] = await db.$queryRaw<{ total: number; items: QueueRow[] }[]>(
    approvalQueueSql(callerId, filter, page).statement,
  );
  return row ?? { total: 0, items: [] };
}

/** Rejects one step as the acting user, with the reason, bound to the version they saw. */
export async function rejectStep(
  tx: AuditedTransaction,
  target: {
    orderId: string;
    round: number;
    step: number;
    approverId: string;
    version: number;
    reason: string;
  },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE approval_steps
       SET state = 'REJECTED', decided_by = ${target.approverId}::uuid, decided_at = now(),
           decided_version = ${target.version}, reason = ${target.reason}
     WHERE order_id = ${target.orderId}::uuid AND round = ${target.round}
       AND step = ${target.step}`;
}

/**
 * Voids the round's steps in `states` (ADR-0001): a reject voids the steps still open after
 * it; a withdraw voids every step, an approved one keeping its decision.
 */
export async function voidSteps(
  tx: AuditedTransaction,
  orderId: string,
  round: number,
  states: readonly ('OPEN' | 'APPROVED')[],
): Promise<void> {
  await tx.$executeRaw`
    UPDATE approval_steps SET state = 'VOIDED', voided_at = now()
     WHERE order_id = ${orderId}::uuid AND round = ${round} AND state = ANY(${[...states]}::text[])`;
}

/** T8: the round closes REJECTED and the order is rejected, final. */
export async function rejectRoundAndOrder(
  tx: AuditedTransaction,
  orderId: string,
  round: number,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE approval_rounds SET outcome = 'REJECTED', closed_at = now()
     WHERE order_id = ${orderId}::uuid AND round = ${round}`;
  await tx.$executeRaw`
    UPDATE purchase_orders SET status = 'REJECTED', version = version + 1
     WHERE id = ${orderId}::uuid`;
}

/**
 * T10: the order is cancelled by the acting Approver with their reason; the database sets
 * cancelled_at and checks the rest (D9-D11).
 */
export async function cancelApprovedOrder(
  tx: AuditedTransaction,
  target: { orderId: string; approverId: string; reason: string },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE purchase_orders
       SET status = 'CANCELLED', cancelled_by = ${target.approverId}::uuid,
           cancel_reason = ${target.reason}, version = version + 1
     WHERE id = ${target.orderId}::uuid`;
}

/** Each line's ordered and received quantity, in position order, for PO_CANCELLED. Read
 * under the order's lock: every line change locks its order first (ADR-0006). */
export async function selectLineQuantities(
  tx: AuditedTransaction,
  orderId: string,
): Promise<AuditCancelledLine[]> {
  return tx.$queryRaw<AuditCancelledLine[]>`
    SELECT id::text AS "lineId", position, quantity, received_quantity AS "receivedQuantity"
      FROM order_lines WHERE order_id = ${orderId}::uuid ORDER BY position`;
}

/** T9: the round closes WITHDRAWN with the owner's reason, and the order is a draft again. */
export async function withdrawRoundAndOrder(
  tx: AuditedTransaction,
  orderId: string,
  round: number,
  reason: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE approval_rounds SET outcome = 'WITHDRAWN', closed_at = now(), withdraw_reason = ${reason}
     WHERE order_id = ${orderId}::uuid AND round = ${round}`;
  await tx.$executeRaw`
    UPDATE purchase_orders SET status = 'DRAFT', submitted_at = NULL, version = version + 1
     WHERE id = ${orderId}::uuid`;
}

/** The round's steps with any decision, for PO_WITHDRAWN's voided steps. */
export interface StepRecord {
  step: number;
  tier: number;
  decision: { id: string; name: string; at: Date; version: number } | null;
}

export async function selectStepRecords(
  tx: AuditedTransaction,
  orderId: string,
  round: number,
): Promise<StepRecord[]> {
  const rows = await tx.$queryRaw<
    {
      step: number;
      tier: number;
      id: string | null;
      name: string | null;
      at: Date | null;
      version: number | null;
    }[]
  >`
    SELECT s.step::int AS step, s.tier::int AS tier, s.decided_by::text AS id, u.name,
           s.decided_at AS at, s.decided_version AS version
      FROM approval_steps s LEFT JOIN users u ON u.id = s.decided_by
     WHERE s.order_id = ${orderId}::uuid AND s.round = ${round}
     ORDER BY s.step`;
  return rows.map((row) => ({
    step: row.step,
    tier: row.tier,
    decision:
      row.id !== null && row.name !== null && row.at !== null && row.version !== null
        ? { id: row.id, name: row.name, at: row.at, version: row.version }
        : null,
  }));
}
