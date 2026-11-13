import { createHash } from 'node:crypto';

// The fingerprint of a create's body (research R5): SHA-256 of its canonical JSON, with
// object keys sorted at every depth, so the same request sent with its keys in another
// order or other whitespace is recognised as the same; any other difference is not.

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function requestHash(body: unknown): Buffer {
  return createHash('sha256')
    .update(JSON.stringify(canonical(body)))
    .digest();
}
