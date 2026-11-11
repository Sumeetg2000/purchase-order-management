import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { VendorStatusFilter } from '@po/contracts';
import { api } from '../../api/app-client';
import { dataOrThrow } from '../../api/client';

// The vendor screens' reads (ADR-0018). Every key starts with VENDORS_KEY, so a change
// refreshes the list and the open vendor at once.

export const VENDORS_KEY = ['vendors'] as const;

export const vendorKey = (id: string) => [...VENDORS_KEY, 'vendor', id] as const;

export interface VendorListParams {
  /** Left out for the API's default, ACTIVE. */
  status?: VendorStatusFilter | undefined;
  q?: string | undefined;
  page?: number | undefined;
}

export function useVendorList({ status, q, page }: VendorListParams) {
  const query = {
    ...(status === undefined ? {} : { status }),
    ...(q ? { q } : {}),
    ...(page === undefined || page === 1 ? {} : { page }),
  };
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
  });
}
