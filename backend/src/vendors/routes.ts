import {
  API_PATH_PREFIX,
  etagFor,
  OPERATIONS,
  type PageQuery,
  type VendorBody,
  type VendorListQuery,
} from '@po/contracts';
import {
  defineRoute,
  idParamOf,
  ifMatchVersionOf,
  type RouteDefinition,
} from '../http/define-route.js';
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
      ...OPERATIONS.listVendorHistory,
      handler: async (req, res) => {
        res.json(
          await vendors.listVendorHistory(idParamOf(req), req.query as unknown as PageQuery),
        );
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
    defineRoute({
      ...OPERATIONS.updateVendor,
      handler: async (req, res) => {
        const target = {
          id: idParamOf(req),
          version: ifMatchVersionOf(res),
          body: req.body as VendorBody,
        };
        const vendor = await vendors.updateVendor(authOf(res), target, requestContext(req, res));
        res.set('ETag', etagFor(vendor.version)).json(vendor);
      },
    }),
    defineRoute({
      ...OPERATIONS.deactivateVendor,
      handler: async (req, res) => {
        const target = { id: idParamOf(req), version: ifMatchVersionOf(res) };
        const vendor = await vendors.deactivateVendor(
          authOf(res),
          target,
          requestContext(req, res),
        );
        res.set('ETag', etagFor(vendor.version)).json(vendor);
      },
    }),
    defineRoute({
      ...OPERATIONS.reactivateVendor,
      handler: async (req, res) => {
        const target = { id: idParamOf(req), version: ifMatchVersionOf(res) };
        const vendor = await vendors.reactivateVendor(
          authOf(res),
          target,
          requestContext(req, res),
        );
        res.set('ETag', etagFor(vendor.version)).json(vendor);
      },
    }),
  ];
}
