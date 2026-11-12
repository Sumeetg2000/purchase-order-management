import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessRequestStatus, RoleFilter, UserStatus } from '@po/contracts';
import { api } from '../../api/app-client';
import { dataOrThrow } from '../../api/client';
import { definedParams } from '../../api/query-params';
import { VERSIONED_STALE_TIME_MS } from '../../app/stale-times';

// The admin screens' reads (ADR-0016, ADR-0018). Every key starts with ADMIN_KEY, so an
// admin action refreshes the lists, the open detail and the Users badge at once.

export const ADMIN_KEY = ['admin'] as const;

/** How often the Users badge reads the open-request count (ADR-0018). */
export const OPEN_COUNT_REFRESH_MS = 60_000;

export interface UserListParams {
  role?: RoleFilter | undefined;
  status?: UserStatus | undefined;
  q?: string | undefined;
  page?: number | undefined;
}

export interface AccessRequestListParams {
  status?: AccessRequestStatus | undefined;
  page?: number | undefined;
}

export function useUserList(params: UserListParams) {
  const query = definedParams(params);
  return useQuery({
    queryKey: [...ADMIN_KEY, 'users', query],
    queryFn: async () => dataOrThrow(await api.GET('/admin/users', { params: { query } })),
    placeholderData: keepPreviousData,
  });
}

export function useUserDetail(id: string) {
  return useQuery({
    queryKey: [...ADMIN_KEY, 'user', id],
    queryFn: async () =>
      dataOrThrow(await api.GET('/admin/users/{id}', { params: { path: { id } } })),
    // A dialog reads the version it will send; it must be the current one.
    staleTime: VERSIONED_STALE_TIME_MS,
  });
}

/** How many active Approvers there are, for the only-Approver warning (ADR-0018). */
export function useActiveApproverCount(enabled: boolean) {
  return useQuery({
    queryKey: [...ADMIN_KEY, 'users', 'active-approvers'],
    queryFn: async () => {
      const query = { role: 'APPROVER', status: 'ACTIVE', pageSize: 1 } as const;
      return dataOrThrow(await api.GET('/admin/users', { params: { query } })).total;
    },
    enabled,
  });
}

export function useAccessRequestList(params: AccessRequestListParams) {
  const query = definedParams(params);
  return useQuery({
    queryKey: [...ADMIN_KEY, 'access-requests', query],
    queryFn: async () =>
      dataOrThrow(await api.GET('/admin/access-requests', { params: { query } })),
    placeholderData: keepPreviousData,
  });
}

/** The open-request count on the Users badge: every 60 s, on focus and after actions. */
export function useOpenRequestCount(enabled: boolean) {
  return useQuery({
    queryKey: [...ADMIN_KEY, 'access-requests', 'open-count'],
    queryFn: async () => {
      const query = { status: 'OPEN', pageSize: 1 } as const;
      return dataOrThrow(await api.GET('/admin/access-requests', { params: { query } })).total;
    },
    enabled,
    refetchInterval: OPEN_COUNT_REFRESH_MS,
    // Even within the default stale time: the badge is how admins notice new requests.
    refetchOnWindowFocus: 'always',
  });
}

/** Refreshes every admin read after a change. */
export function useRefreshAdmin() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
}
