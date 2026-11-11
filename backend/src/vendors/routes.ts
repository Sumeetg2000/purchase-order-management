import {
  API_PATH_PREFIX,
  etagFor,
  OPERATIONS,
  type VendorBody,
  type VendorListQuery,
} from '@po/contracts';
import { defineRoute, idParamOf, type RouteDefinition } from '../http/define-route.js';
import { authOf } from '../http/middleware/authorize.js';
import { requestContext } from '../http/request-context.js';
import type { VendorsService } from './service.js';

export function vendorRoutes(vendors: VendorsService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.listVendors,
      handler: async (req, res) => {
        res.json(await vendors.listVendors(req.query as unknown as VendorListQuery));
      },
    }),
    defineRoute({
      ...OPERATIONS.getVendor,
      handler: async (req, res) => {
        const vendor = await vendors.getVendor(idParamOf(req));
        res.set('ETag', etagFor(vendor.version)).json(vendor);
      },
    }),
    defineRoute({
      ...OPERATIONS.createVendor,
      handler: async (req, res) => {
        const vendor = await vendors.createVendor(
          authOf(res),
          req.body as VendorBody,
          requestContext(req, res),
        );
        res
          .status(201)
          .set('ETag', etagFor(vendor.version))
          .set('Location', `${API_PATH_PREFIX}/vendors/${vendor.id}`)
          .json(vendor);
      },
    }),
  ];
}
