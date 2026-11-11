import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { etagFor, type ErrorCode, type VendorStatusFilter } from '@po/contracts';
import { api } from '../../api/app-client';
import { dataOrThrow } from '../../api/client';
import { submit } from '../../api/submit';

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

/** A status change's failures that mean the page is out of date: they offer Reload. */
export const STALE_STATUS_CODES: ReadonlySet<string> = new Set([
  'VERSION_CONFLICT',
  'INVALID_STATE_TRANSITION',
] satisfies ErrorCode[]);

/**
 * Deactivate or reactivate, sent with the version the page shows. On success the open
 * vendor takes the answer and every list refreshes.
 */
export function useChangeVendorStatus() {
  const queryClient = useQueryClient();
  return async (vendor: { id: string; version: number }, action: 'deactivate' | 'reactivate') => {
    const params = {
      path: { id: vendor.id },
      header: { 'If-Match': etagFor(vendor.version) },
    };
    const outcome = await submit(() =>
      action === 'deactivate'
        ? api.POST('/vendors/{id}/deactivate', { params })
        : api.POST('/vendors/{id}/reactivate', { params }),
    );
    if (outcome.ok) {
      queryClient.setQueryData(vendorKey(vendor.id), outcome.data);
      void queryClient.invalidateQueries({ queryKey: [...VENDORS_KEY, 'list'] });
    }
    return outcome;
  };
}
