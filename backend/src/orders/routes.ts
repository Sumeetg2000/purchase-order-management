import {
  API_PATH_PREFIX,
  etagFor,
  OPERATIONS,
  type CreateOrderBody,
  type DeleteOrderBody,
  type EditOrderBody,
  type OrderListQuery,
  type PageQuery,
} from '@po/contracts';
import {
  defineRoute,
  idempotencyKeyOf,
  idParamOf,
  ifMatchVersionOf,
  type RouteDefinition,
} from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import { requestContext } from '../http/request-context.js';
import type { OrdersService } from './service.js';

export function orderRoutes(orders: OrdersService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.listOrders,
      handler: async (req, res) => {
        res.json(await orders.listOrders(authOf(res), req.query as unknown as OrderListQuery));
      },
    }),
    defineRoute({
      ...OPERATIONS.listOrderTimeline,
      handler: async (req, res) => {
        res.json(
          await orders.listOrderTimeline(
            authOf(res),
            idParamOf(req),
            req.query as unknown as PageQuery,
          ),
        );
      },
    }),
    defineRoute({
      ...OPERATIONS.getOrder,
      handler: async (req, res) => {
        const order = await orders.getOrder(authOf(res), idParamOf(req));
        res.set('ETag', etagFor(order.version)).json(order);
      },
    }),
    defineRoute({
      ...OPERATIONS.createOrder,
      handler: async (req, res) => {
        // A replay answers exactly as the original create did (research R5).
        const { order } = await orders.createOrder(
          authOf(res),
          { body: req.body as CreateOrderBody, idempotencyKey: idempotencyKeyOf(res) },
          requestContext(req, res),
        );
        res
          .status(201)
          .set('ETag', etagFor(order.version))
          .set('Location', `${API_PATH_PREFIX}/orders/${order.id}`)
          .json(order);
      },
    }),
    defineRoute({
      ...OPERATIONS.editOrder,
      handler: async (req, res) => {
        const target = {
          id: idParamOf(req),
          version: ifMatchVersionOf(res),
          body: req.body as EditOrderBody,
        };
        const order = await orders.editOrder(authOf(res), target, requestContext(req, res));
        res.set('ETag', etagFor(order.version)).json(order);
      },
    }),
    defineRoute({
      ...OPERATIONS.deleteOrder,
      handler: async (req, res) => {
        const target = {
          id: idParamOf(req),
          version: ifMatchVersionOf(res),
          reason: (req.body as DeleteOrderBody).reason ?? null,
        };
        await orders.deleteOrder(authOf(res), target, requestContext(req, res));
        res.status(204).end();
      },
    }),
  ];
}
