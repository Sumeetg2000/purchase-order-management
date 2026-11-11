import type { AppPrismaClient } from '../db/client.js';
import type { AuditAction, AuditEventCatalogue } from './events.js';

// Reads of the audit trail by entity (research R10): one entity's entries, newest first,
// served by audit_entries_entity_idx (entity_type, entity_id, occurred_at DESC, id DESC).
// Writes go only through writeAudit.

export type AuditEntityType = AuditEventCatalogue[AuditAction]['entityType'];

/** An entry as stored, the actor as the trigger snapshotted them at the time. */
export interface EntityHistoryRow {
  id: string;
  action: string;
  occurredAt: Date;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  actingRole: string | null;
  details: unknown;
}

export interface EntityRef {
  entityType: AuditEntityType;
  entityId: string;
}

/** A page of the entity's entries, newest first; equal timestamps by id, newest first. */
export function listEntityHistory(
  prisma: AppPrismaClient,
  { entityType, entityId }: EntityRef,
  { offset, limit }: { offset: number; limit: number },
): Promise<EntityHistoryRow[]> {
  return prisma.$queryRaw<EntityHistoryRow[]>`
    SELECT id::text, action, occurred_at AS "occurredAt", actor_type AS "actorType",
           actor_name AS "actorName", actor_email AS "actorEmail",
           acting_role AS "actingRole", details
      FROM audit_entries
     WHERE entity_type = ${entityType} AND entity_id = ${entityId}
     ORDER BY occurred_at DESC, id DESC
     LIMIT ${limit} OFFSET ${offset}`;
}

export async function countEntityHistory(
  prisma: AppPrismaClient,
  { entityType, entityId }: EntityRef,
): Promise<number> {
  const [row] = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT count(*) AS total FROM audit_entries
     WHERE entity_type = ${entityType} AND entity_id = ${entityId}`;
  return Number(row?.total ?? 0);
}
