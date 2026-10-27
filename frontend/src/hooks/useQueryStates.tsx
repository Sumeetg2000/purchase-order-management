import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Empty, type EmptyProps } from '../components/Empty';
import { ErrorState } from '../components/ErrorState';
import { Loading } from '../components/Loading';
import { problemFrom } from '../errors/problem';

export interface QueryStateOptions<T> {
  loadingLabel: string;
  /** When given with `empty`, data for which this is true renders the empty state. */
  isEmpty?: (data: T) => boolean;
  empty?: EmptyProps;
}

/** `view` is an element (always truthy) exactly when there is no data, so `if (view)` narrows. */
export type QueryStates<T> = { view: ReactElement; data: undefined } | { view: null; data: T };

/**
 * The loading, error and empty states for a TanStack Query result, so pages don't hand-roll
 * them: render `view` when it is set, otherwise use `data`.
 */
export function useQueryStates<T>(
  query: UseQueryResult<T>,
  { loadingLabel, isEmpty, empty }: QueryStateOptions<T>,
): QueryStates<T> {
  if (query.isPending) return { view: <Loading label={loadingLabel} />, data: undefined };
  if (query.isError) {
    const problem = problemFrom(query.error);
    const retry = () => {
      void query.refetch();
    };
    return { view: <ErrorState problem={problem} onRetry={retry} />, data: undefined };
  }
  if (empty && isEmpty?.(query.data)) return { view: <Empty {...empty} />, data: undefined };
  return { view: null, data: query.data };
}
