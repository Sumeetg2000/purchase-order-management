import {
  AppError,
  type Page,
  type Vendor,
  type VendorBody,
  type VendorListQuery,
} from '@po/contracts';
import type { AuthenticatedUser } from '../auth/service.js';
import { writeAudit } from '../audit/write.js';
import type { AppPrismaClient } from '../db/client.js';
import { violatedConstraint } from '../db/errors.js';
import {
  withDatabase,
  type AuditedTransaction,
  type TransactionRunner,
} from '../db/transaction.js';
import type { RequestContext } from '../lib/request-context.js';
import { buyerActor } from '../users/actor.js';
import {
  countVendors,
  findClash,
  findVendor,
  findVendorByNameKey,
  insertVendor,
  listVendors,
  lockVendor,
  updateVendor,
  type VendorFields,
} from './repository.js';
import { termColumns, toSnapshot, toVendor } from './snapshot.js';

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
}

/** The unique constraint on vendors.name_key (migration 0011). */
const NAME_KEY_CONSTRAINT = 'vendors_name_key_key';

export interface VendorsServiceDependencies {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
}

function fieldsOf(body: VendorBody): VendorFields {
  return {
    name: body.name,
    contactName: body.contactName,
    contactEmail: body.contactEmail,
    // Omitted or null: no phone, stored as NULL, never "" (research R6).
    contactPhone: body.contactPhone ?? null,
    ...termColumns(body.paymentTerms),
  };
}

export function createVendorsService(deps: VendorsServiceDependencies): VendorsService {
  /** Runs `fn` audited as the Buyer. */
  function asBuyer<T>(
    buyer: AuthenticatedUser,
    ctx: RequestContext,
    fn: (tx: AuditedTransaction) => Promise<T>,
  ): Promise<T> {
    const actor = buyerActor({ id: buyer.userId, name: buyer.name, email: buyer.email });
    return deps.transactions.run({ actor, requestId: ctx.requestId, logger: ctx.logger }, fn);
  }

  return {
    listVendors: async (query) => {
      const filter = { status: query.status, q: query.q };
      const [rows, total] = await withDatabase(() =>
        Promise.all([
          listVendors(deps.prisma, {
            ...filter,
            offset: (query.page - 1) * query.pageSize,
            limit: query.pageSize,
          }),
          countVendors(deps.prisma, filter),
        ]),
      );
      return { items: rows.map(toVendor), page: query.page, pageSize: query.pageSize, total };
    },

    getVendor: async (id) => {
      const row = await withDatabase(() => findVendor(deps.prisma, id));
      if (!row) throw new AppError('NOT_FOUND');
      return toVendor(row);
    },

    createVendor: async (buyer, body, ctx) => {
      const row = await asBuyer(buyer, ctx, async (tx) => {
        const created = await insertVendor(tx, fieldsOf(body));
        if (!created) {
          // The insert waited for any in-flight one, so the winner is visible now (R3).
          const existing = await findVendorByNameKey(tx, body.name);
          if (!existing) throw new Error('Vendor insert conflicted, but no vendor holds the name');
          throw new AppError('DUPLICATE_VENDOR_NAME', { existingVendor: existing });
        }
        await writeAudit(tx, {
          action: 'VENDOR_CREATED',
          entityType: 'vendor',
          entityId: created.id,
          details: { before: null, after: toSnapshot(created) },
        });
        return created;
      });
      return toVendor(row);
    },

    updateVendor: async (buyer, { id, version, body }, ctx) => {
      try {
        const row = await asBuyer(buyer, ctx, async (tx) => {
          const current = await lockVendor(tx, id);
          if (!current) throw new AppError('NOT_FOUND');
          if (current.version !== version) throw new AppError('VERSION_CONFLICT');
          const clash = await findClash(tx, body.name, id);
          if (clash) throw new AppError('DUPLICATE_VENDOR_NAME', { existingVendor: clash });
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
        const existing = await withDatabase(() => findVendorByNameKey(deps.prisma, body.name));
        if (!existing) {
          throw new Error('Vendor rename conflicted, but no vendor holds the name', {
            cause: error,
          });
        }
        throw new AppError('DUPLICATE_VENDOR_NAME', { existingVendor: existing, cause: error });
      }
    },
  };
}
