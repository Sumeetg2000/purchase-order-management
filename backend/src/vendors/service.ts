import {
  AppError,
  ROLE,
  type Page,
  type PageQuery,
  type Vendor,
  type VendorBody,
  type VendorHistoryItem,
  type VendorListQuery,
  type VendorStatus,
} from '@po/contracts';
import { z } from 'zod';
import type { AuthenticatedUser } from '../auth/service.js';
import { listEntityHistory } from '../audit/repository.js';
import { writeAudit } from '../audit/write.js';
import type { AppPrismaClient } from '../db/client.js';
import { violatedConstraint } from '../db/errors.js';
import {
  withDatabase,
  type AuditedTransaction,
  type TransactionRunner,
} from '../db/transaction.js';
import { pageArgs, toPage } from '../lib/pagination.js';
import type { RequestContext } from '../lib/request-context.js';
import { runAs } from '../users/actor.js';
import {
  findVendorByNameKey,
  insertVendor,
  listVendors,
  selectVendor,
  setVendorStatus,
  updateVendor,
  type VendorFields,
} from './repository.js';
import { toHistoryItem } from './history.js';
import {
  fieldsOf,
  statusOf,
  toOrderSnapshot,
  toSnapshot,
  toVendor,
  type VendorOrderSnapshot,
  type VendorRow,
} from './snapshot.js';

// The shared vendor list (ADR-0005): Buyers add vendors; every role reads them.

export interface VendorsService {
  listVendors(query: VendorListQuery): Promise<Page<Vendor>>;
  getVendor(id: string): Promise<Vendor>;
  /** Adds a vendor; a name whose key another vendor has is DUPLICATE_VENDOR_NAME. */
  createVendor(buyer: AuthenticatedUser, body: VendorBody, ctx: RequestContext): Promise<Vendor>;
  /** Replaces a vendor's details when `version` is current (research R7, R8). */
  updateVendor(
    buyer: AuthenticatedUser,
    target: { id: string; version: number; body: VendorBody },
    ctx: RequestContext,
  ): Promise<Vendor>;
  /** The vendor's audit entries, newest first (research R10); NOT_FOUND for no vendor. */
  listVendorHistory(id: string, query: PageQuery): Promise<Page<VendorHistoryItem>>;
  /** ACTIVE → INACTIVE when `version` is current; otherwise INVALID_STATE_TRANSITION. */
  deactivateVendor(
    buyer: AuthenticatedUser,
    target: { id: string; version: number },
    ctx: RequestContext,
  ): Promise<Vendor>;
  /** INACTIVE → ACTIVE when `version` is current; otherwise INVALID_STATE_TRANSITION. */
  reactivateVendor(
    buyer: AuthenticatedUser,
    target: { id: string; version: number },
    ctx: RequestContext,
  ): Promise<Vendor>;
}

/** A status change: where it starts, where it ends, and its audit action. */
export const TRANSITIONS = {
  deactivate: { from: 'ACTIVE', to: 'INACTIVE', action: 'VENDOR_DEACTIVATED' },
  reactivate: { from: 'INACTIVE', to: 'ACTIVE', action: 'VENDOR_REACTIVATED' },
} as const satisfies Record<
  string,
  {
    from: VendorStatus;
    to: VendorStatus;
    action: 'VENDOR_DEACTIVATED' | 'VENDOR_REACTIVATED';
  }
>;

/**
 * The order slices' vendor check (research R9), run inside the caller's
 * transaction after it has locked the order and its lines (ADR-0006 lock order). Reads the
 * vendor under FOR SHARE and returns the snapshot an order stores on submit. A missing id
 * or malformed id is VALIDATION_FAILED with VENDOR_NOT_FOUND at `path` (the caller's field,
 * e.g. `body.vendorId`); a malformed one never reaches PostgreSQL, so the caller's
 * transaction stays usable. An inactive vendor is VENDOR_INACTIVE.
 *
 * The FOR SHARE lock is held until the caller's transaction ends. Concurrent checks of the
 * same vendor don't block each other, but every vendor write takes FOR UPDATE: a
 * deactivate or reactivate, and an edit too, waits for each order transaction that has
 * checked the vendor. Order transactions must therefore stay short: nothing slow (no
 * mail, no external call, no waiting on a user) between this check and the commit.
 */
export async function requireActiveVendor(
  tx: AuditedTransaction,
  vendorId: string,
  path: string,
): Promise<VendorOrderSnapshot> {
  const row = z.uuid().safeParse(vendorId).success
    ? await selectVendor(tx, vendorId, 'share')
    : null;
  if (!row) {
    throw new AppError('VALIDATION_FAILED', { details: [{ path, code: 'VENDOR_NOT_FOUND' }] });
  }
  if (statusOf(row) !== 'ACTIVE') throw new AppError('VENDOR_INACTIVE');
  return toOrderSnapshot(row);
}

/**
 * Inserts the vendor and audits it, or returns null when its name key is taken (research
 * R3). Shared by the API and the demo seed, so both record a creation the same way.
 */
export async function createAuditedVendor(
  tx: AuditedTransaction,
  fields: VendorFields,
): Promise<VendorRow | null> {
  const created = await insertVendor(tx, fields);
  if (!created) return null;
  await writeAudit(tx, {
    action: 'VENDOR_CREATED',
    entityType: 'vendor',
    entityId: created.id,
    details: { before: null, after: toSnapshot(created) },
  });
  return created;
}

/**
 * Moves the locked vendor along `transition` and audits it; the caller has checked the
 * version and the state (research R8). Shared by the API and the demo seed.
 */
export async function changeAuditedStatus(
  tx: AuditedTransaction,
  current: VendorRow,
  transition: (typeof TRANSITIONS)[keyof typeof TRANSITIONS],
): Promise<VendorRow> {
  const changed = await setVendorStatus(tx, current.id, transition.to);
  await writeAudit(tx, {
    action: transition.action,
    entityType: 'vendor',
    entityId: current.id,
    details: { before: toSnapshot(current), after: toSnapshot(changed) },
  });
  return changed;
}

/** The unique constraint on vendors.name_key (migration 0011). */
const NAME_KEY_CONSTRAINT = 'vendors_name_key_key';

/**
 * The error for a name whose key was taken: DUPLICATE_VENDOR_NAME naming the vendor that
 * holds it, or, when that vendor was renamed away in between (research R3), the retryable
 * CONCURRENCY_RETRY_EXHAUSTED, since the name is free again and a retry wins.
 */
async function duplicateNameError(
  db: AuditedTransaction | AppPrismaClient,
  name: string,
  cause?: unknown,
): Promise<AppError> {
  const existing = await findVendorByNameKey(db, name);
  return existing
    ? new AppError('DUPLICATE_VENDOR_NAME', { existingVendor: existing, cause })
    : new AppError('CONCURRENCY_RETRY_EXHAUSTED', { cause });
}

/** Locks the vendor and checks the client's version: NOT_FOUND, then VERSION_CONFLICT. */
async function lockCurrent(
  tx: AuditedTransaction,
  { id, version }: { id: string; version: number },
): Promise<VendorRow> {
  const current = await selectVendor(tx, id, 'update');
  if (!current) throw new AppError('NOT_FOUND');
  if (current.version !== version) throw new AppError('VERSION_CONFLICT');
  return current;
}

interface VendorsServiceDependencies {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
}

export function createVendorsService(deps: VendorsServiceDependencies): VendorsService {
  /** Runs `fn` audited as the Buyer. */
  function asBuyer<T>(
    buyer: AuthenticatedUser,
    ctx: RequestContext,
    fn: (tx: AuditedTransaction) => Promise<T>,
  ): Promise<T> {
    return runAs(deps.transactions, buyer, ROLE.BUYER, ctx, fn);
  }

  /** Lock → 404 → version → state → update and audit (research R8). */
  async function changeStatus(
    transition: (typeof TRANSITIONS)[keyof typeof TRANSITIONS],
    buyer: AuthenticatedUser,
    target: { id: string; version: number },
    ctx: RequestContext,
  ): Promise<Vendor> {
    const row = await asBuyer(buyer, ctx, async (tx) => {
      const current = await lockCurrent(tx, target);
      if (statusOf(current) !== transition.from) {
        throw new AppError('INVALID_STATE_TRANSITION');
      }
      return changeAuditedStatus(tx, current, transition);
    });
    return toVendor(row);
  }

  return {
    deactivateVendor: (buyer, target, ctx) =>
      changeStatus(TRANSITIONS.deactivate, buyer, target, ctx),
    reactivateVendor: (buyer, target, ctx) =>
      changeStatus(TRANSITIONS.reactivate, buyer, target, ctx),

    listVendors: async (query) => {
      const result = await withDatabase(() =>
        listVendors(deps.prisma, { status: query.status, q: query.q, ...pageArgs(query) }),
      );
      return toPage(query, result, toVendor);
    },

    listVendorHistory: async (id, query) => {
      const entity = { entityType: 'vendor', entityId: id } as const;
      const [vendor, history] = await withDatabase(() =>
        Promise.all([
          selectVendor(deps.prisma, id),
          listEntityHistory(deps.prisma, entity, pageArgs(query)),
        ]),
      );
      if (!vendor) throw new AppError('NOT_FOUND');
      return toPage(query, history, toHistoryItem);
    },

    getVendor: async (id) => {
      const row = await withDatabase(() => selectVendor(deps.prisma, id));
      if (!row) throw new AppError('NOT_FOUND');
      return toVendor(row);
    },

    createVendor: async (buyer, body, ctx) => {
      const row = await asBuyer(buyer, ctx, async (tx) => {
        const created = await createAuditedVendor(tx, fieldsOf(body));
        // The insert waited for any in-flight one, so the winner is visible now (R3).
        if (!created) throw await duplicateNameError(tx, body.name);
        return created;
      });
      return toVendor(row);
    },

    updateVendor: async (buyer, { id, version, body }, ctx) => {
      try {
        const row = await asBuyer(buyer, ctx, async (tx) => {
          const current = await lockCurrent(tx, { id, version });
          const holder = await findVendorByNameKey(tx, body.name);
          if (holder && holder.id !== current.id) {
            throw new AppError('DUPLICATE_VENDOR_NAME', { existingVendor: holder });
          }
          const updated = await updateVendor(tx, id, fieldsOf(body));
          await writeAudit(tx, {
            action: 'VENDOR_UPDATED',
            entityType: 'vendor',
            entityId: id,
            details: { before: toSnapshot(current), after: toSnapshot(updated) },
          });
          return updated;
        });
        return toVendor(row);
      } catch (error) {
        if (violatedConstraint(error) !== NAME_KEY_CONSTRAINT) throw error;
        // A concurrent rename committed the key after our clash check (research R3): the
        // transaction has rolled back, so the winner is read on its own.
        throw await withDatabase(() => duplicateNameError(deps.prisma, body.name, error));
      }
    },
  };
}
