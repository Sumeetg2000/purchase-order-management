import type { AgeBucket } from '@po/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/app-client';
import { dataOrThrow } from '../../api/client';
import { definedParams } from '../../api/query-params';
import { ORDERS_KEY } from '../orders/queries';

// The outstanding report's reads (ADR-0018). Keyed under the orders' key, so a receipt,
// a cancel or an approval (which invalidate ORDERS_KEY) refreshes the report too.

export const OUTSTANDING_KEY = [...ORDERS_KEY, 'outstanding'] as const;

export interface OutstandingParams {
  vendorId?: string | undefined;
  ageBucket?: AgeBucket | undefined;
  page?: number | undefined;
}

export function useOutstandingReport(params: OutstandingParams, { enabled = true } = {}) {
  const query = definedParams(params);
  return useQuery({
    queryKey: [...OUTSTANDING_KEY, 'orders', query],
    queryFn: async () =>
      dataOrThrow(await api.GET('/reports/outstanding', { params: { query } })),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useOutstandingVendors(params: { page?: number | undefined }) {
  const query = definedParams(params);
  return useQuery({
    queryKey: [...OUTSTANDING_KEY, 'vendors', query],
    queryFn: async () =>
      dataOrThrow(await api.GET('/reports/outstanding/vendors', { params: { query } })),
    placeholderData: keepPreviousData,
  });
}
