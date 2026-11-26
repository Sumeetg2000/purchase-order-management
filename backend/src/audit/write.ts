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

/**
 * Records several audit events in the caller's transaction with one INSERT … SELECT FROM
 * unnest, whatever their number (slice 6 research R6): a 500-line receipt writes its 500
 * entries in one statement. The database fills each row's actor and request id from the
 * transaction's context, as for writeAudit; rows keep the events' order. An empty list
 * sends nothing.
 */
export async function writeAuditBatch(
  tx: AuditedTransaction,
  events: readonly AuditEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO audit_entries (action, entity_type, entity_id, order_id, po_number, details)
    SELECT e.action, e.entity_type, e.entity_id, e.order_id, e.po_number, e.details
      FROM unnest(${events.map((e) => e.action)}::text[],
                  ${events.map((e) => e.entityType)}::text[],
                  ${events.map((e) => e.entityId)}::text[],
                  ${events.map((e) => e.orderId ?? null)}::uuid[],
                  ${events.map((e) => e.poNumber ?? null)}::text[],
                  ${events.map((e) => JSON.stringify(e.details))}::text[]::jsonb[])
           WITH ORDINALITY AS e(action, entity_type, entity_id, order_id, po_number, details, n)
     ORDER BY e.n`;
}
