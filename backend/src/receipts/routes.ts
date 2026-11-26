import { API_PATH_PREFIX, OPERATIONS, type PageQuery, type RecordReceiptBody } from '@po/contracts';
import {
  defineRoute,
  idempotencyKeyOf,
  idParamOf,
  receiptIdParamOf,
  type RouteDefinition,
} from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import { requestContext } from '../http/request-context.js';
import type { ReceiptsService } from './service.js';

export function receiptRoutes(receipts: ReceiptsService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.recordReceipt,
      handler: async (req, res) => {
        // A replay answers exactly as the original receipt did (research R7).
        const orderId = idParamOf(req);
        const receipt = await receipts.recordReceipt(
          authOf(res),
          {
            orderId,
            body: req.body as RecordReceiptBody,
            idempotencyKey: idempotencyKeyOf(res),
          },
          requestContext(req, res),
        );
        res
          .status(201)
          .set('Location', `${API_PATH_PREFIX}/orders/${orderId}/receipts/${receipt.id}`)
          .json(receipt);
      },
    }),
    defineRoute({
      ...OPERATIONS.listOrderReceipts,
      handler: async (req, res) => {
        res.json(
          await receipts.listOrderReceipts(
            authOf(res),
            idParamOf(req),
            req.query as unknown as PageQuery,
          ),
        );
      },
    }),
    defineRoute({
      ...OPERATIONS.getOrderReceipt,
      handler: async (req, res) => {
        res.json(
          await receipts.getOrderReceipt(authOf(res), idParamOf(req), receiptIdParamOf(req)),
        );
      },
    }),
  ];
}
