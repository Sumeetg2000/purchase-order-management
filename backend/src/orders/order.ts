import { toMoney, vendorOrderSnapshot, type ApprovalRound, type Order } from '@po/contracts';
import type { AuditOrderLine } from '../audit/events.js';
import type { ApprovalRoundRow, OrderRow } from './repository.js';

// Rows → the API's order (contracts/api.md). Amounts stay strings: toMoney checks and
// normalises the database's text, never a float.

export function toOrder(header: OrderRow): Order {
  const lines = header.lines;
  if (header.poNumber === null) throw new Error(`order ${header.id} has no PO number`);
  return {
    id: header.id,
    poNumber: header.poNumber,
    status: header.status,
    vendor: { id: header.vendorId, name: header.vendorName, status: header.vendorStatus },
    owner: { id: header.ownerId, name: header.ownerName },
    total: toMoney(header.total),
    lineCount: lines.length,
    lines: lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unitPrice: toMoney(line.unitPrice),
      lineTotal: toMoney(line.lineTotal),
    })),
    version: header.version,
    createdAt: header.createdAt.toISOString(),
    updatedAt: header.updatedAt.toISOString(),
    submittedAt: header.submittedAt?.toISOString() ?? null,
    approvedAt: header.approvedAt?.toISOString() ?? null,
    ownerCanAct: header.ownerCanAct,
    // A non-draft order shows its vendor as submitted; a draft (a withdrawn one too) the
    // live vendor above (ADR-0005).
    vendorSnapshot:
      header.status === 'DRAFT' || header.approval === null
        ? null
        : vendorOrderSnapshot.parse(header.approval.vendorSnapshot),
    approval: header.approval === null ? null : toApprovalRound(header.approval),
    cancellation:
      header.cancellation === null
        ? null
        : { ...header.cancellation, cancelledAt: iso(header.cancellation.cancelledAt) },
  };
}

/** JSON timestamps (PostgreSQL text) → ISO strings, as every other API time. */
const iso = (at: string): string => new Date(at).toISOString();

export function toApprovalRound(row: ApprovalRoundRow): ApprovalRound {
  return {
    round: row.round,
    policyVersion: row.policyVersion,
    outcome: row.outcome,
    submittedAt: iso(row.submittedAt),
    closedAt: row.closedAt === null ? null : iso(row.closedAt),
    withdrawReason: row.withdrawReason,
    steps: row.steps.map((step) => ({
      step: step.step,
      tier: step.tier,
      threshold: toMoney(step.threshold),
      state: step.state,
      decidedBy: step.decidedBy,
      decidedAt: step.decidedAt === null ? null : iso(step.decidedAt),
      reason: step.reason,
    })),
  };
}

/** The lines as an order audit entry records them. */
export function auditLines(order: Order): AuditOrderLine[] {
  return order.lines.map(({ id, description, quantity, unitPrice, lineTotal }) => ({
    id,
    description,
    quantity,
    unitPrice,
    lineTotal,
  }));
}
