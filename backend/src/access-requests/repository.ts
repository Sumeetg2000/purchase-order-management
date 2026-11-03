import { ACCESS_REQUEST_STATUSES, type AccessRequestStatus } from '@po/contracts';
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
  const status = ACCESS_REQUEST_STATUSES.find((known) => known === row.status);
  if (!status) throw new Error(`access request ${row.id} has an unknown status: ${row.status}`);
  return { ...row, status };
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
    where: { userId: request.userId, status: 'OPEN' },
    select: { id: true },
  });
  const row = open
    ? await tx.accessRequest.update({
        where: { id: open.id },
        data: { message: request.message },
        select: COLUMNS,
      })
    : await tx.accessRequest.create({
        data: { id: uuidv7(), userId: request.userId, message: request.message, status: 'OPEN' },
        select: COLUMNS,
      });
  return parsed(row);
}
