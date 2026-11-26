import {
  ACCESS_REQUEST_STATUS,
  ACCESS_REQUEST_STATUSES,
  type AccessRequestStatus,
} from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { pageNumber } from '../orders/repository.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';
import type { PageArgs, RowsAndTotal } from '../lib/pagination.js';

// Access requests (migration 0009_access_requests, ADR-0016). A user has at most one open
// request; decided ones stay as they were.

export interface AccessRequest {
  id: string;
  status: AccessRequestStatus;
  message: string;
  adminNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
}

const COLUMNS = {
  id: true,
  status: true,
  message: true,
  adminNote: true,
  createdAt: true,
  updatedAt: true,
  decidedAt: true,
} as const;

/** A stored status, parsed: the CHECK allows only ACCESS_REQUEST_STATUSES. */
function parsed(row: Omit<AccessRequest, 'status'> & { status: string }): AccessRequest {
  return { ...row, status: statusOf(row) };
}

function statusOf(row: { id: string; status: string }): AccessRequestStatus {
  const status = ACCESS_REQUEST_STATUSES.find((known) => known === row.status);
  if (!status) throw new Error(`access request ${row.id} has an unknown status: ${row.status}`);
  return status;
}

/** A user's latest request, or null if they never sent one. */
export async function findLatestAccessRequest(
  prisma: AppPrismaClient,
  userId: string,
): Promise<AccessRequest | null> {
  const row = await prisma.accessRequest.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: COLUMNS,
  });
  return row && parsed(row);
}

/**
 * Sets the message of the user's open request, or opens one. The caller holds the user's
 * row lock, so two sends can't both open a request.
 */
export async function openOrUpdateAccessRequest(
  tx: AuditedTransaction,
  request: { userId: string; message: string },
): Promise<AccessRequest> {
  const open = await tx.accessRequest.findFirst({
    where: { userId: request.userId, status: ACCESS_REQUEST_STATUS.OPEN },
    select: { id: true },
  });
  const row = open
    ? await tx.accessRequest.update({
        where: { id: open.id },
        data: { message: request.message },
        select: COLUMNS,
      })
    : await tx.accessRequest.create({
        data: {
          id: uuidv7(),
          userId: request.userId,
          message: request.message,
          status: ACCESS_REQUEST_STATUS.OPEN,
        },
        select: COLUMNS,
      });
  return parsed(row);
}

type DecidedStatus = Exclude<AccessRequestStatus, 'OPEN'>;

/**
 * Closes the user's open request, if any, and returns its id. The caller holds the user's
 * row lock, so no send can open or update one meanwhile.
 */
export async function closeOpenAccessRequest(
  tx: AuditedTransaction,
  close: {
    userId: string;
    status: DecidedStatus;
    /** The deciding admin, or null for a dismissal by deactivation. */
    decidedBy: string | null;
    note: string | null;
    now: Date;
  },
): Promise<string | null> {
  const [closed] = await tx.$queryRaw<{ id: string }[]>`
    UPDATE access_requests
       SET status = ${close.status}, decided_by = ${close.decidedBy}::uuid,
           decided_at = ${close.now}, admin_note = ${close.note}
     WHERE user_id = ${close.userId}::uuid AND status = ${ACCESS_REQUEST_STATUS.OPEN}
    RETURNING id`;
  return closed?.id ?? null;
}

/** A request as the admin list shows it, with its user. */
export interface AdminAccessRequestRow extends AccessRequest {
  user: { id: string; name: string; email: string; createdAt: Date };
}

const ADMIN_COLUMNS = {
  ...COLUMNS,
  user: { select: { id: true, name: true, email: true, createdAt: true } },
} as const;

function withUser(
  row: Omit<AdminAccessRequestRow, 'status'> & { status: string },
): AdminAccessRequestRow {
  return { ...row, status: statusOf(row) };
}

export interface AccessRequestListSql {
  /** What the API runs: the page and the total in one statement, one snapshot. */
  statement: Prisma.Sql;
  /** Its parts, each planned on its own: for the plan tests and committed plans. */
  page: Prisma.Sql;
  count: Prisma.Sql;
}

const iso = (column: string) =>
  Prisma.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/**
 * The admin list's SQL (slice 7, closing ADR-0021): newest activity first, by
 * access_requests_updated_idx or, with a status, access_requests_status_updated_idx, to
 * the page and no further; only the page's users are read.
 */
export function accessRequestListSql(
  filter: { status?: AccessRequestStatus | undefined },
  { offset, limit }: PageArgs,
): AccessRequestListSql {
  const where =
    filter.status === undefined ? Prisma.sql`true` : Prisma.sql`r.status = ${filter.status}`;
  const page = Prisma.sql`SELECT r.id, r.status, r.message, r.admin_note, r.created_at,
           r.updated_at, r.decided_at, r.user_id
      FROM access_requests r WHERE ${where}
     ORDER BY r.updated_at DESC, r.id DESC
     LIMIT ${pageNumber(limit)} OFFSET ${pageNumber(offset)}`;
  const count = Prisma.sql`SELECT count(*) FROM access_requests r WHERE ${where}`;
  const statement = Prisma.sql`
    SELECT (${count})::int AS total,
           (SELECT json_agg(json_build_object(
                     'id', p.id::text, 'status', p.status, 'message', p.message,
                     'adminNote', p.admin_note, 'createdAt', ${iso('p.created_at')},
                     'updatedAt', ${iso('p.updated_at')},
                     'decidedAt', ${iso('p.decided_at')},
                     'user', json_build_object('id', u.id::text, 'name', u.name,
                                               'email', u.email,
                                               'createdAt', ${iso('u.created_at')}))
                   ORDER BY p.updated_at DESC, p.id DESC)
              FROM (${page}) p JOIN users u ON u.id = p.user_id) AS items`;
  return { statement, page, count };
}

interface ListedRequest {
  id: string;
  status: string;
  message: string;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  user: { id: string; name: string; email: string; createdAt: string };
}

/** A page of requests, newest activity first, and the number of matches, in one statement. */
export async function listAccessRequests(
  prisma: AppPrismaClient,
  filter: { status?: AccessRequestStatus | undefined } & PageArgs,
): Promise<RowsAndTotal<AdminAccessRequestRow>> {
  const [row] = await prisma.$queryRaw<{ total: number; items: ListedRequest[] | null }[]>(
    accessRequestListSql(filter, filter).statement,
  );
  const rows = (row?.items ?? []).map((r) =>
    withUser({
      ...r,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
      decidedAt: r.decidedAt === null ? null : new Date(r.decidedAt),
      user: { ...r.user, createdAt: new Date(r.user.createdAt) },
    }),
  );
  return { rows, total: row?.total ?? 0 };
}

/** The user a request belongs to, or null if there is no such request. */
export async function findAccessRequestUserId(
  tx: AuditedTransaction,
  id: string,
): Promise<string | null> {
  const row = await tx.accessRequest.findUnique({ where: { id }, select: { userId: true } });
  return row?.userId ?? null;
}

/** Locks a request's row and returns its status, or null if there is no such request. */
export async function lockAccessRequest(
  tx: AuditedTransaction,
  id: string,
): Promise<AccessRequestStatus | null> {
  const [row] = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status FROM access_requests WHERE id = ${id}::uuid FOR UPDATE`;
  return row ? statusOf(row) : null;
}

/** Dismisses a request the caller has locked and found open. */
export async function dismissAccessRequest(
  tx: AuditedTransaction,
  dismissal: { id: string; decidedBy: string; note: string | null; now: Date },
): Promise<AdminAccessRequestRow> {
  const row = await tx.accessRequest.update({
    where: { id: dismissal.id },
    data: {
      status: ACCESS_REQUEST_STATUS.DISMISSED,
      decidedBy: dismissal.decidedBy,
      decidedAt: dismissal.now,
      adminNote: dismissal.note,
    },
    select: ADMIN_COLUMNS,
  });
  return withUser(row);
}
