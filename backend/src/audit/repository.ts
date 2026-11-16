import type { AppPrismaClient } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PageArgs, RowsAndTotal } from '../lib/pagination.js';
import type { AuditAction, AuditEventCatalogue } from './events.js';

// Reads of the audit trail by entity (research R10): one entity's entries, newest first,
// served by audit_entries_entity_idx (entity_type, entity_id, occurred_at DESC, id DESC).
// Writes go only through writeAudit.

type AuditEntityType = AuditEventCatalogue[AuditAction]['entityType'];

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

interface EntityRef {
  entityType: AuditEntityType;
  entityId: string;
}

/** The history's SQL: the statement the API runs, and its parts for the plan files. */
export function entityHistorySql(
  { entityType, entityId }: EntityRef,
  { offset, limit }: PageArgs,
): { statement: Prisma.Sql; page: Prisma.Sql; count: Prisma.Sql } {
  const where = Prisma.sql`entity_type = ${entityType} AND entity_id = ${entityId}`;
  // The sort names the table: a bare `id` would mean a selected `id::text`, sorted as text.
  const page = Prisma.sql`
    SELECT id, action, occurred_at, actor_type, actor_name, actor_email, acting_role, details
      FROM audit_entries
     WHERE ${where}
     ORDER BY audit_entries.occurred_at DESC, audit_entries.id DESC
     LIMIT ${limit} OFFSET ${offset}`;
  const count = Prisma.sql`SELECT count(*) FROM audit_entries WHERE ${where}`;
  const statement = Prisma.sql`
    SELECT (${count})::int AS total,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', p.id::text,
                      'action', p.action,
                      'occurredAt', to_char(p.occurred_at AT TIME ZONE 'UTC',
                                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                      'actorType', p.actor_type,
                      'actorName', p.actor_name,
                      'actorEmail', p.actor_email,
                      'actingRole', p.acting_role,
                      'details', p.details)
                    ORDER BY p.occurred_at DESC, p.id DESC)
               FROM (${page}) p), '[]'::json) AS rows`;
  return { statement, page, count };
}

/**
 * A page of the entity's entries, newest first, and how many it has; equal timestamps by
 * id, newest first. One statement, one snapshot, so the page and the total always agree.
 */
export async function listEntityHistory(
  prisma: AppPrismaClient,
  entity: EntityRef,
  page: PageArgs,
): Promise<RowsAndTotal<EntityHistoryRow>> {
  const [result] = await prisma.$queryRaw<
    { total: number; rows: (Omit<EntityHistoryRow, 'occurredAt'> & { occurredAt: string })[] }[]
  >(entityHistorySql(entity, page).statement);
  const rows = (result?.rows ?? []).map((row) => ({
    ...row,
    occurredAt: new Date(row.occurredAt),
  }));
  return { rows, total: result?.total ?? 0 };
}
