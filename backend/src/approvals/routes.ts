import {
  etagFor,
  OPERATIONS,
  type ApprovalQueueQuery,
  type DecisionReasonBody,
} from '@po/contracts';
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
      ...OPERATIONS.approveOrder,
      handler: async (req, res) => {
        const order = await approvals.approveOrder(
          authOf(res),
          { id: idParamOf(req), version: ifMatchVersionOf(res) },
          requestContext(req, res),
        );
        res.set('ETag', etagFor(order.version)).json(order);
      },
    }),
    defineRoute({
      ...OPERATIONS.rejectOrder,
      handler: async (req, res) => {
        const { reason } = req.body as DecisionReasonBody;
        const order = await approvals.rejectOrder(
          authOf(res),
          { id: idParamOf(req), version: ifMatchVersionOf(res), reason },
          requestContext(req, res),
        );
        res.set('ETag', etagFor(order.version)).json(order);
      },
    }),
    defineRoute({
      ...OPERATIONS.withdrawOrder,
      handler: async (req, res) => {
        const { reason } = req.body as DecisionReasonBody;
        const order = await approvals.withdrawOrder(
          authOf(res),
          { id: idParamOf(req), version: ifMatchVersionOf(res), reason },
          requestContext(req, res),
        );
        res.set('ETag', etagFor(order.version)).json(order);
      },
    }),
    defineRoute({
      ...OPERATIONS.cancelOrder,
      handler: async (req, res) => {
        const { reason } = req.body as DecisionReasonBody;
        const order = await approvals.cancelOrder(
          authOf(res),
          { id: idParamOf(req), version: ifMatchVersionOf(res), reason },
          requestContext(req, res),
        );
        res.set('ETag', etagFor(order.version)).json(order);
      },
    }),
    defineRoute({
      ...OPERATIONS.listApprovalQueue,
      handler: async (req, res) => {
        res.json(
          await approvals.listApprovalQueue(
            authOf(res),
            req.query as unknown as ApprovalQueueQuery,
          ),
        );
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
