import { API_PATH_PREFIX, etagFor, OPERATIONS, type CreateOrderBody } from '@po/contracts';
import {
  defineRoute,
  idempotencyKeyOf,
  idParamOf,
  type RouteDefinition,
} from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import { requestContext } from '../http/request-context.js';
import type { OrdersService } from './service.js';

export function orderRoutes(orders: OrdersService): RouteDefinition[] {
  return [
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
  ];
}
