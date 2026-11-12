import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { etagFor, type ErrorCode, type VendorStatusFilter } from '@po/contracts';
import { api } from '../../api/app-client';
import { dataOrThrow } from '../../api/client';
import { definedParams } from '../../api/query-params';
import type { paths } from '../../api/schema';
import { VERSIONED_STALE_TIME_MS } from '../../app/stale-times';

// The vendor screens' reads (ADR-0018). Every key starts with VENDORS_KEY, so a change
// refreshes the list and the open vendor at once.

export const VENDORS_KEY = ['vendors'] as const;

export const vendorKey = (id: string) => [...VENDORS_KEY, 'vendor', id] as const;

export type Vendor = paths['/vendors/{id}']['get']['responses'][200]['content']['application/json'];

export interface VendorListParams {
  /** Left out for the API's default, ACTIVE. */
  status?: VendorStatusFilter | undefined;
  q?: string | undefined;
  page?: number | undefined;
}

export function useVendorList(params: VendorListParams) {
  const query = definedParams(params);
  return useQuery({
    queryKey: [...VENDORS_KEY, 'list', query],
    queryFn: async () => dataOrThrow(await api.GET('/vendors', { params: { query } })),
    placeholderData: keepPreviousData,
  });
}

export function useVendor(id: string) {
  return useQuery({
    queryKey: vendorKey(id),
    queryFn: async () => dataOrThrow(await api.GET('/vendors/{id}', { params: { path: { id } } })),
    // Edit and the status actions send the version this read shows.
    staleTime: VERSIONED_STALE_TIME_MS,
  });
}

/** A status change's failures that mean the page is out of date: they offer Reload. */
const STALE_STATUS_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'VERSION_CONFLICT',
  'INVALID_STATE_TRANSITION',
]);

/** Whether a problem's code, as received, is one of STALE_STATUS_CODES. */
export function isStaleStatusCode(code: string): boolean {
  return (STALE_STATUS_CODES as ReadonlySet<string>).has(code);
}

/** After a vendor is saved: the open vendor takes the answer and every list refreshes. */
export function useVendorSaved() {
  const queryClient = useQueryClient();
  return (vendor: Vendor) => {
    queryClient.setQueryData(vendorKey(vendor.id), vendor);
    void queryClient.invalidateQueries({ queryKey: [...VENDORS_KEY, 'list'] });
  };
}

/** Deactivate or reactivate, sent with the version the page shows. */
export function changeVendorStatus(
  vendor: { id: string; version: number },
  action: 'deactivate' | 'reactivate',
) {
  const params = { path: { id: vendor.id }, header: { 'If-Match': etagFor(vendor.version) } };
  return action === 'deactivate'
    ? api.POST('/vendors/{id}/deactivate', { params })
    : api.POST('/vendors/{id}/reactivate', { params });
}

/** One page of a vendor's history, newest first (Buyers and Admins). */
export function useVendorHistory(id: string, page: number) {
  const query = definedParams({ page });
  return useQuery({
    queryKey: [...vendorKey(id), 'history', query],
    queryFn: async () =>
      dataOrThrow(await api.GET('/vendors/{id}/history', { params: { path: { id }, query } })),
    placeholderData: keepPreviousData,
  });
}
