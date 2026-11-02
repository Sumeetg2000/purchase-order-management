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
  /** Shown while the query isn't enabled yet, so has nothing to load. Defaults to nothing. */
  idle?: ReactElement;
}

/**
 * `view` is an element (always truthy) exactly when there is no data to show, so
 * `if (view)` narrows. `notice` is set when a refresh failed but earlier data is still
 * shown: render it above the data.
 */
export type QueryStates<T> =
  | { view: ReactElement; data: undefined; notice: null }
  | { view: null; data: T; notice: ReactElement | null };

/**
 * The idle, loading, error and empty states for a TanStack Query result, so pages don't
 * hand-roll them: render `view` when it is set, otherwise `notice` and `data`.
 */
export function useQueryStates<T>(
  query: UseQueryResult<T>,
  { loadingLabel, isEmpty, empty, idle }: QueryStateOptions<T>,
): QueryStates<T> {
  const retry = () => {
    void query.refetch();
  };
  const error = query.isError ? (
    <ErrorState problem={problemFrom(query.error)} onRetry={retry} />
  ) : null;

  if (query.data === undefined) {
    if (error) return { view: error, data: undefined, notice: null };
    // A disabled query stays pending without fetching (TanStack Query v5).
    if (query.fetchStatus === 'idle') return { view: idle ?? <></>, data: undefined, notice: null };
    return { view: <Loading label={loadingLabel} />, data: undefined, notice: null };
  }
  if (empty && isEmpty?.(query.data)) {
    return {
      view: (
        <>
          {error}
          <Empty {...empty} />
        </>
      ),
      data: undefined,
      notice: null,
    };
  }
  // A failed background refresh keeps the data the user is looking at.
  return { view: null, data: query.data, notice: error };
}
