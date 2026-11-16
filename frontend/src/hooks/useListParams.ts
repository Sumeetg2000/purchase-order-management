import { oneOf } from '@po/contracts';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

/** A query-string value if it is one of the allowed ones, else undefined. */
export function pickOne<const T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | undefined {
  return oneOf(allowed, value) ? value : undefined;
}

/** A page number from the URL: a positive integer, else the first page. */
export function pageParam(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/** Search params from the set values only, in the given order; page 1 is left out. */
export function toSearch(values: Record<string, string | number | undefined>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '' || (key === 'page' && value === 1)) continue;
    search.set(key, String(value));
  }
  return search;
}

/** A filter's allowed values, or TEXT for free text (trimmed; blank is unset). */
export const TEXT = 'text';

export type ListParamSpec = Readonly<Record<string, readonly string[] | typeof TEXT>>;

export type ListParams<S extends ListParamSpec> = {
  -readonly [K in keyof S]:
    (S[K] extends readonly (infer T extends string)[] ? T : string) | undefined;
} & { page: number };

export interface ListParamsOptions<S extends ListParamSpec> {
  /** Values the API assumes when the parameter is absent: the URL leaves them out. */
  defaults?: Partial<ListParams<S>>;
}

/**
 * A paged list's filters and page, kept in the URL (ADR-0018) so Back, Forward and a
 * shared link show the same list. `show` changes filters from page 1; `setPage` keeps them.
 */
export function useListParams<const S extends ListParamSpec>(
  spec: S,
  { defaults = {} }: ListParamsOptions<S> = {},
) {
  const [search, setSearch] = useSearchParams();
  const read = (from: URLSearchParams) => {
    const found = {} as Record<string, string | number | undefined>;
    for (const [key, allowed] of Object.entries(spec)) {
      const raw = from.get(key);
      found[key] = allowed === TEXT ? raw?.trim() || undefined : pickOne(raw, allowed);
    }
    found.page = pageParam(from.get('page'));
    return found;
  };
  const params = read(search) as ListParams<S>;
  // The URL last written, until a render shows it: React Router's function form of
  // setSearchParams gives this render's params, not the latest navigation's.
  const written = useRef<URLSearchParams | undefined>(undefined);
  useEffect(() => {
    written.current = undefined;
  }, [search]);

  /**
   * Writes the next URL from the one current when the change is made, not from this
   * render's: two changes before the next render (a filter chosen as a debounced search
   * fires) must both land.
   */
  const write = (
    next: (
      current: Record<string, string | number | undefined>,
    ) => Record<string, string | number | undefined>,
    replace: boolean,
  ) => {
    const shown = Object.fromEntries(
      Object.entries(next(read(written.current ?? search))).map(([key, value]) => [
        key,
        value === (defaults as Record<string, unknown>)[key] ? undefined : value,
      ]),
    );
    written.current = toSearch(shown);
    setSearch(written.current, { replace });
  };

  return {
    params,
    /** Changes filters and goes back to page 1; `replace` for as-you-type changes. */
    show: (next: Partial<ListParams<S>>, { replace = false }: { replace?: boolean } = {}) => {
      write((current) => ({ ...current, page: 1, ...next }), replace);
    },
    setPage: (page: number) => {
      write((current) => ({ ...current, page }), false);
    },
  };
}
