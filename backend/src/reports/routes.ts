import { OPERATIONS, type OutstandingReportQuery, type PageQuery } from '@po/contracts';
import { defineRoute, type RouteDefinition } from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import type { ReportsService } from './service.js';

export function reportRoutes(reports: ReportsService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.listOutstandingOrders,
      handler: async (req, res) => {
        res.json(
          await reports.listOutstandingOrders(
            authOf(res),
            req.query as unknown as OutstandingReportQuery,
          ),
        );
      },
    }),
    defineRoute({
      ...OPERATIONS.listOutstandingVendors,
      handler: async (req, res) => {
        res.json(
          await reports.listOutstandingVendors(authOf(res), req.query as unknown as PageQuery),
        );
      },
    }),
  ];
}
