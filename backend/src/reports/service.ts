import { ROLE, type OutstandingOrder, type OutstandingReportQuery } from '@po/contracts';
import type { AuthenticatedUser } from '../auth/service.js';
import type { AppPrismaClient } from '../db/client.js';
import type { Clock } from '../lib/clock.js';
import { indiaToday } from '../lib/india-date.js';
import { pageArgs } from '../lib/pagination.js';
import { listOutstandingOrders, type ReportScope } from './repository.js';

// The outstanding orders report (specs/008-outstanding-report, research R1–R3): reads
// only, scoped by role, ages counted to today's India date from the injected clock.

export interface OutstandingReportPage {
  items: OutstandingOrder[];
  page: number;
  pageSize: number;
  total: number;
  asOf: string;
}

export interface ReportsService {
  listOutstandingOrders(
    user: AuthenticatedUser,
    query: OutstandingReportQuery,
  ): Promise<OutstandingReportPage>;
}

interface ReportsServiceDependencies {
  prisma: AppPrismaClient;
  clock: Clock;
}

/**
 * Whose outstanding orders a caller sees (ADR-0004, research R2): a caller who is only a
 * Buyer sees their own; an Approver or Admin sees all, since every outstanding order is
 * approved and so readable to them.
 */
export function reportScopeOf(user: Pick<AuthenticatedUser, 'userId' | 'roles'>): ReportScope {
  const seesAll = user.roles.includes(ROLE.APPROVER) || user.roles.includes(ROLE.ADMIN);
  return seesAll ? { kind: 'all' } : { kind: 'own', ownerId: user.userId };
}

export function createReportsService(deps: ReportsServiceDependencies): ReportsService {
  return {
    listOutstandingOrders: async (user, query) => {
      const asOf = indiaToday(deps.clock);
      const { items, total } = await listOutstandingOrders(
        deps.prisma,
        reportScopeOf(user),
        { vendorId: query.vendorId, ageBucket: query.ageBucket },
        asOf,
        pageArgs(query),
      );
      return { items, page: query.page, pageSize: query.pageSize, total, asOf };
    },
  };
}
