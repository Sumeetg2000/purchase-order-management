import { etagFor } from '@po/contracts';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrderStatus } from '@po/contracts';
import { api } from '../../api/app-client';
import { dataOrThrow } from '../../api/client';
import { definedParams } from '../../api/query-params';
import type { paths } from '../../api/schema';
import { VERSIONED_STALE_TIME_MS } from '../../app/stale-times';
import { VENDORS_KEY } from '../vendors/queries';

// The order screens' reads and writes (ADR-0018). Every key starts with ORDERS_KEY.

export const ORDERS_KEY = ['orders'] as const;

export const orderKey = (id: string) => [...ORDERS_KEY, 'order', id] as const;

export type Order = paths['/orders/{id}']['get']['responses'][200]['content']['application/json'];

export type CreateOrderBody = NonNullable<
  paths['/orders']['post']['requestBody']
>['content']['application/json'];

export function useOrder(id: string) {
  return useQuery({
    queryKey: orderKey(id),
    queryFn: async () => dataOrThrow(await api.GET('/orders/{id}', { params: { path: { id } } })),
    // Edit and delete send the version this read shows.
    staleTime: VERSIONED_STALE_TIME_MS,
  });
}

/** After an order is saved: the open order takes the answer and every list refreshes. */
export function useOrderSaved() {
  const queryClient = useQueryClient();
  return (order: Order) => {
    queryClient.setQueryData(orderKey(order.id), order);
    void queryClient.invalidateQueries({ queryKey: [...ORDERS_KEY, 'list'] });
  };
}

/** Creates a draft with the attempt's Idempotency-Key (research R5). */
export function createOrder(body: CreateOrderBody, idempotencyKey: string) {
  return api.POST('/orders', { params: { header: { 'Idempotency-Key': idempotencyKey } }, body });
}

export type EditOrderBody = NonNullable<
  paths['/orders/{id}']['patch']['requestBody']
>['content']['application/json'];

/** Replaces a draft's vendor and lines, with the version the editor started from. */
export function editOrder(id: string, version: number, body: EditOrderBody) {
  return api.PATCH('/orders/{id}', {
    params: { path: { id }, header: { 'If-Match': etagFor(version) } },
    body,
  });
}

/** Takes the owner's pending order back to draft, with a reason and its version. */
export function withdrawOrder(id: string, version: number, reason: string) {
  return api.POST('/orders/{id}/withdraw', {
    params: { path: { id }, header: { 'If-Match': etagFor(version) } },
    body: { reason },
  });
}

/** Cancels an approved order with a reason and its version (slice 5); final. */
export function cancelOrder(id: string, version: number, reason: string) {
  return api.POST('/orders/{id}/cancel', {
    params: { path: { id }, header: { 'If-Match': etagFor(version) } },
    body: { reason },
  });
}

/** Submits a draft with the version it shows (slice 4); the server routes it. */
export function submitOrder(id: string, version: number) {
  return api.POST('/orders/{id}/submit', {
    params: { path: { id }, header: { 'If-Match': etagFor(version) } },
  });
}

export type ApprovalPolicy =
  paths['/approval-policy']['get']['responses'][200]['content']['application/json'];

/** The current approval policy, for the submit dialog's expected outcome (ADR-0002). */
export function useApprovalPolicy() {
  return useQuery({
    queryKey: ['approval-policy'] as const,
    queryFn: async () => dataOrThrow(await api.GET('/approval-policy')),
  });
}

/** Active vendors whose name starts with `q`, for the order's vendor picker. */
export function useActiveVendors(q: string | undefined) {
  const query = definedParams({ status: 'ACTIVE' as const, q });
  return useQuery({
    queryKey: [...VENDORS_KEY, 'list', query],
    queryFn: async () => dataOrThrow(await api.GET('/vendors', { params: { query } })),
  });
}

export interface OrderListParams {
  status?: OrderStatus | undefined;
  vendorId?: string | undefined;
  poNumber?: string | undefined;
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/**
 * A page of the orders the caller may read, filtered in the database (research R7). Not
 * `enabled` while a filter is one the API would refuse: nothing is asked.
 */
export function useOrderList(params: OrderListParams, { enabled = true } = {}) {
  const query = definedParams(params);
  return useQuery({
    queryKey: [...ORDERS_KEY, 'list', query],
    queryFn: async () => dataOrThrow(await api.GET('/orders', { params: { query } })),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * How many of the caller's drafts use a vendor, for the deactivate dialog: the order list
 * itself, a page of one read for its total (research R11), so no other count exists.
 */
export function useDraftCount(vendorId: string) {
  return useOrderList({ vendorId, status: 'DRAFT', pageSize: 1 });
}

/** One page of an order's timeline, newest first. */
export function useOrderTimeline(id: string, page: number) {
  const query = definedParams({ page });
  return useQuery({
    queryKey: [...orderKey(id), 'timeline', query],
    queryFn: async () =>
      dataOrThrow(await api.GET('/orders/{id}/timeline', { params: { path: { id }, query } })),
    placeholderData: keepPreviousData,
  });
}

/** One page of an order's receipt summaries, newest first; not fetched until `enabled`. */
export function useOrderReceipts(id: string, page: number, { enabled = true } = {}) {
  const query = definedParams({ page });
  return useQuery({
    queryKey: [...orderKey(id), 'receipts', query],
    queryFn: async () =>
      dataOrThrow(await api.GET('/orders/{id}/receipts', { params: { path: { id }, query } })),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** One receipt's lines, loaded when the receipt is expanded. */
export function useOrderReceipt(id: string, receiptId: string, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...orderKey(id), 'receipts', 'receipt', receiptId],
    queryFn: async () =>
      dataOrThrow(
        await api.GET('/orders/{id}/receipts/{receiptId}', {
          params: { path: { id, receiptId } },
        }),
      ),
    enabled,
  });
}
