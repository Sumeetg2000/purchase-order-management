import { useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Active vendors whose name starts with `q`, for the order's vendor picker. */
export function useActiveVendors(q: string | undefined) {
  const query = definedParams({ status: 'ACTIVE' as const, q });
  return useQuery({
    queryKey: [...VENDORS_KEY, 'list', query],
    queryFn: async () => dataOrThrow(await api.GET('/vendors', { params: { query } })),
  });
}
