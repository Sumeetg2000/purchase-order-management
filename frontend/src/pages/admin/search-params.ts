/** A query-string value if it is one of the allowed ones, else undefined. */
export function oneOf<const T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((candidate) => candidate === value);
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
