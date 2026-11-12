// How long reads stay fresh in the TanStack Query cache.

/**
 * How long a read counts as fresh: a page visited again within it shows what it read
 * without asking again. Version-sensitive reads override it (VERSIONED_STALE_TIME_MS).
 */
export const DEFAULT_STALE_TIME_MS = 30_000;

/**
 * For a read whose `version` a change sends back as If-Match: always read again, so a
 * dialog or form starts from the current version.
 */
export const VERSIONED_STALE_TIME_MS = 0;
