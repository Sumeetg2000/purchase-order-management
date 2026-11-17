import { etagFor } from '@po/contracts';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/app-client';
import { dataOrThrow } from '../../api/client';
import { definedParams } from '../../api/query-params';
import { ORDERS_KEY } from '../orders/queries';

// The approval queue and its nav count (ADR-0018). Keys sit under ORDERS_KEY, so every
// order action refreshes the queue and the count with the order lists.

export const APPROVALS_KEY = [...ORDERS_KEY, 'approvals'] as const;

/** How often the nav reads the pending-approvals count (ADR-0018, as the Users badge). */
export const APPROVALS_COUNT_REFRESH_MS = 60_000;

export interface ApprovalQueueParams {
  vendorId?: string | undefined;
  poNumber?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/** A page of the orders waiting for the caller's approval (research R7). */
export function useApprovalQueue(params: ApprovalQueueParams) {
  const query = definedParams(params);
  return useQuery({
    queryKey: [...APPROVALS_KEY, 'queue', query],
    queryFn: async () => dataOrThrow(await api.GET('/approvals', { params: { query } })),
    placeholderData: keepPreviousData,
  });
}

/** The nav count: the queue's total, a page of one, every 60 s, on focus, after actions. */
export function useApprovalCount(enabled: boolean) {
  return useQuery({
    queryKey: [...APPROVALS_KEY, 'count'],
    queryFn: async () =>
      dataOrThrow(await api.GET('/approvals', { params: { query: { pageSize: 1 } } })).total,
    enabled,
    refetchInterval: APPROVALS_COUNT_REFRESH_MS,
    refetchOnWindowFocus: 'always',
  });
}

/** Refreshes the queue and the count after an order action. */
export function useRefreshApprovals() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
}

/** Approves the order's current step with the version it shows. */
export function approveOrder(id: string, version: number) {
  return api.POST('/orders/{id}/approve', {
    params: { path: { id }, header: { 'If-Match': etagFor(version) } },
  });
}
