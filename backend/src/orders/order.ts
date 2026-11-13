import { toMoney, type Order } from '@po/contracts';
import type { AuditOrderLine } from '../audit/events.js';
import type { OrderRow } from './repository.js';

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
