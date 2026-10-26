import type { AuditedTransaction } from '../db/transaction.js';
import type { AuditEvent } from './events.js';

/**
 * Records an audit event in the caller's transaction, so it commits or rolls back with
 * the change it describes. It takes an AuditedTransaction, which only withTransaction
 * hands out, so it always runs with the actor context the database requires.
 */
export async function writeAudit(tx: AuditedTransaction, event: AuditEvent): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_entries (action, entity_type, entity_id, order_id, po_number, details)
    VALUES (${event.action}, ${event.entityType}, ${event.entityId},
            ${event.orderId ?? null}::uuid, ${event.poNumber ?? null},
            ${JSON.stringify(event.details)}::jsonb)`;
}
