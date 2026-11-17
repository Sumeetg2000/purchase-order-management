import { etagFor, OPERATIONS } from '@po/contracts';
import {
  defineRoute,
  idParamOf,
  ifMatchVersionOf,
  type RouteDefinition,
} from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import { requestContext } from '../http/request-context.js';
import type { ApprovalsService } from './service.js';

export function approvalRoutes(approvals: ApprovalsService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.submitOrder,
      handler: async (req, res) => {
        const order = await approvals.submitOrder(
          authOf(res),
          { id: idParamOf(req), version: ifMatchVersionOf(res) },
          requestContext(req, res),
        );
        res.set('ETag', etagFor(order.version)).json(order);
      },
    }),
    defineRoute({
      ...OPERATIONS.getApprovalPolicy,
      handler: async (_req, res) => {
        res.json(await approvals.getApprovalPolicy());
      },
    }),
  ];
}
