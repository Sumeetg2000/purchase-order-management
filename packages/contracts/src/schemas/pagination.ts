import { z } from 'zod';

// Offset pagination on every collection (ADR-0007).

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 50;

/** The page fields, for list queries that add their own filters. */
export const pageQueryShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
};

export const pageQuery = z.strictObject(pageQueryShape);

/** The envelope every list returns. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    page: z.int(),
    pageSize: z.int(),
    total: z.int(),
  });
}

/** A page of items as the API returns it. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export type PageQuery = z.infer<typeof pageQuery>;
