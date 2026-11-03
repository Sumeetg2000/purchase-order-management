import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The bundled common-password list (ADR-0017, research R4). Its content is pinned so an
// accidental edit, truncation or re-download shows up as a failing test.
const FILE = new URL('../../src/auth/common-passwords.txt', import.meta.url);
const EXPECTED_ENTRIES = 1195;
const EXPECTED_SHA256 = 'a2ef37b80fb6b4e13f308dbcda76412c6827efa218f0102641d09b93b8dd15e0';
// The password policy's bounds (ADR-0017): only passwords the policy would accept on
// length are worth listing.
const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

function read() {
  const text = readFileSync(FILE, 'utf8');
  const lines = text.split('\n');
  const comments = lines.filter((line) => line.startsWith('#'));
  const entries = lines.filter((line) => line !== '' && !line.startsWith('#'));
  return { text, comments, entries };
}

describe('[FR-ACC-04] bundled common-password list', () => {
  it('[FR-ACC-04] names its source and licence in a header', () => {
    const header = read().comments.join('\n');
    expect(header).toContain('100k-most-used-passwords-NCSC.txt');
    expect(header).toContain('MIT');
    expect(header).toMatch(/commit\s+#?\s*[0-9a-f]{40}/);
  });

  it('[FR-ACC-04] has the pinned number of entries and SHA-256', () => {
    const { text, entries } = read();
    expect(entries).toHaveLength(EXPECTED_ENTRIES);
    expect(createHash('sha256').update(text).digest('hex')).toBe(EXPECTED_SHA256);
  });

  it('[FR-ACC-04] holds only unique, lower-cased entries of 12 to 128 characters', () => {
    const { entries } = read();
    expect(new Set(entries).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry).toBe(entry.toLowerCase());
      expect(entry.length).toBeGreaterThanOrEqual(MIN_LENGTH);
      expect(entry.length).toBeLessThanOrEqual(MAX_LENGTH);
    }
  });
});
