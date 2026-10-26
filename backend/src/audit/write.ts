import type { TransactionClient } from '../db/transaction.js';
import type { AuditEvent } from './events.js';

/**
 * Records an audit event in the caller's transaction, so it commits or rolls back with
 * the change it describes. Taking a TransactionClient means it can only run inside
 * withTransaction, where the actor context the database requires has been set.
 */
export async function writeAudit(tx: TransactionClient, event: AuditEvent): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_entries (action, entity_type, entity_id, order_id, po_number, details)
    VALUES (${event.action}, ${event.entityType}, ${event.entityId},
            ${event.orderId ?? null}::uuid, ${event.poNumber ?? null},
            ${JSON.stringify(event.details)}::jsonb)`;
}
