/**
 * Only the parameters that are set, in the given order, and no page 1 (the default), so
 * request URLs and query keys stay short and stable.
 */
export function definedParams<T extends object>(
  params: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) => value !== undefined && value !== '' && !(key === 'page' && value === 1),
    ),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
