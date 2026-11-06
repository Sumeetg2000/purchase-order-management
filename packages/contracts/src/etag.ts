// Versioned updates (ADR-0016, research R14): GET and PATCH return `ETag: "<version>"`,
// and a versioned PATCH must send it back in If-Match.

/** A strong ETag holding a version, 1 or more: `"3"`. */
export const ETAG_PATTERN = /^"([1-9][0-9]*)"$/;

export function etagFor(version: number): string {
  return `"${String(version)}"`;
}

/** The highest version a row can hold: versions are PostgreSQL integers. */
export const VERSION_MAX = 2_147_483_647;

/** The version in an If-Match value, or undefined when it isn't one of our ETags. */
export function versionFromEtag(value: string): number | undefined {
  const digits = ETAG_PATTERN.exec(value)?.[1];
  if (digits === undefined) return undefined;
  const version = Number(digits);
  return version <= VERSION_MAX ? version : undefined;
}
