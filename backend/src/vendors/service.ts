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
import { withDatabase, type TransactionRunner } from '../db/transaction.js';
import type { RequestContext } from '../lib/request-context.js';
import { buyerActor } from '../users/actor.js';
import {
  countVendors,
  findVendor,
  findVendorByNameKey,
  insertVendor,
  listVendors,
  type VendorFields,
} from './repository.js';
import { termColumns, toSnapshot, toVendor } from './snapshot.js';

// The shared vendor list (ADR-0005): Buyers add vendors; every role reads them.

export interface VendorsService {
  listVendors(query: VendorListQuery): Promise<Page<Vendor>>;
  getVendor(id: string): Promise<Vendor>;
  /** Adds a vendor; a name whose key another vendor has is DUPLICATE_VENDOR_NAME. */
  createVendor(buyer: AuthenticatedUser, body: VendorBody, ctx: RequestContext): Promise<Vendor>;
}

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
      const actor = buyerActor({ id: buyer.userId, name: buyer.name, email: buyer.email });
      const row = await deps.transactions.run(
        { actor, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          const created = await insertVendor(tx, fieldsOf(body));
          if (!created) {
            // The insert waited for any in-flight one, so the winner is visible now (R3).
            const existing = await findVendorByNameKey(tx, body.name);
            if (!existing)
              throw new Error('Vendor insert conflicted, but no vendor holds the name');
            throw new AppError('DUPLICATE_VENDOR_NAME', { existingVendor: existing });
          }
          await writeAudit(tx, {
            action: 'VENDOR_CREATED',
            entityType: 'vendor',
            entityId: created.id,
            details: { before: null, after: toSnapshot(created) },
          });
          return created;
        },
      );
      return toVendor(row);
    },
  };
}
