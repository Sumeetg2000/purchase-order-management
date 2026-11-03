import { useQuery } from '@tanstack/react-query';
import { api, dataOrThrow } from '../api/client';
import type { paths } from '../api/schema';

export type CurrentUser = paths['/me']['get']['responses'][200]['content']['application/json'];

export const CURRENT_USER_KEY = ['current-user'] as const;

/** The logged-in user, or null when there is none (any 401 from GET /me). */
export function useCurrentUser() {
  return useQuery({
    queryKey: CURRENT_USER_KEY,
    queryFn: async (): Promise<CurrentUser | null> => {
      const result = await api.GET('/me');
      if (result.response.status === 401) return null;
      return dataOrThrow(result);
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}
