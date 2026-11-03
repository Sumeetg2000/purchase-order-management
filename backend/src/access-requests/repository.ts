import {
  ACCESS_REQUEST_STATUS,
  ACCESS_REQUEST_STATUSES,
  type AccessRequestStatus,
} from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { uuidv7 } from '../lib/uuid.js';

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

/** A page of requests, newest activity first, and the number of matches. */
export async function listAccessRequests(
  prisma: AppPrismaClient,
  filter: { status?: AccessRequestStatus | undefined; offset: number; limit: number },
): Promise<{ requests: AdminAccessRequestRow[]; total: number }> {
  const where = filter.status ? { status: filter.status } : {};
  const [rows, total] = await Promise.all([
    prisma.accessRequest.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: filter.offset,
      take: filter.limit,
      select: ADMIN_COLUMNS,
    }),
    prisma.accessRequest.count({ where }),
  ]);
  return { requests: rows.map(withUser), total };
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
