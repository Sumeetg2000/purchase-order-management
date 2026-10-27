import type { AuditedTransaction } from '../db/transaction.js';
import type { AuditEvent } from './events.js';

export class ForbiddenAuditDetailError extends Error {
  override readonly name = 'ForbiddenAuditDetailError';
}

// A phone number never goes into the audit trail (ADR-0016), which keeps entries for
// AUDIT_RETENTION_YEARS (audit/retention.ts) and can't delete them early. The types rule
// out a `phone` key; this run-time check catches any phone-like key at any depth before
// anything is written.
const PHONE_KEY = /phone|mobile/i;

function phoneKeyPath(value: unknown, path: string): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = phoneKeyPath(item, `${path}.${String(index)}`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [key, inner] of Object.entries(value)) {
    if (PHONE_KEY.test(key)) return `${path}.${key}`;
    const found = phoneKeyPath(inner, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

/**
 * Records an audit event in the caller's transaction, so it commits or rolls back with
 * the change it describes. It takes an AuditedTransaction, which only withTransaction
 * hands out, so it always runs with the actor context the database requires.
 */
export async function writeAudit(tx: AuditedTransaction, event: AuditEvent): Promise<void> {
  const phonePath = phoneKeyPath(event.details, 'details');
  if (phonePath) {
    throw new ForbiddenAuditDetailError(`${event.action} carries a phone-like key at ${phonePath}`);
  }
  await tx.$executeRaw`
    INSERT INTO audit_entries (action, entity_type, entity_id, order_id, po_number, details)
    VALUES (${event.action}, ${event.entityType}, ${event.entityId},
            ${event.orderId ?? null}::uuid, ${event.poNumber ?? null},
            ${JSON.stringify(event.details)}::jsonb)`;
}
