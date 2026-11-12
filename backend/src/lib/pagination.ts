import type { Page, PageQuery } from '@po/contracts';

// Every list endpoint pages the same way: the query names a 1-based page and a size, the
// repository reads that slice and the number of matches, and the service maps the rows.

/** The slice of matches a repository reads. */
export interface PageArgs {
  offset: number;
  limit: number;
}

/** What a list repository returns: the page's rows and the number of matches. */
export interface RowsAndTotal<R> {
  rows: R[];
  total: number;
}

/** The slice of matches the query's page covers. */
export function pageArgs(query: PageQuery): PageArgs {
  return { offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
}

/** The response page: the rows mapped, with the query's page, size and the total. */
export function toPage<R, T>(
  query: PageQuery,
  { rows, total }: RowsAndTotal<R>,
  toItem: (row: R) => T,
): Page<T> {
  return {
    items: rows.map((row) => toItem(row)),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}
