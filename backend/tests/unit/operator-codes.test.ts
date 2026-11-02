import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_ERROR_CODES } from '../../src/lib/operator-codes.js';

// The CLI and bootstrap error codes in code are exactly those contracts/cli.md lists in its
// exit-code table, apart from the ones it marks as coming in a later slice.
const contract = readFileSync(
  new URL('../../../specs/001-foundation/contracts/cli.md', import.meta.url),
  'utf8',
);

function documentedCodes(): string[] {
  const table = contract
    .split('\n')
    .filter((line) => /^\| `\d` \|/.test(line))
    .join('\n');
  // "and later `LAST_ADMIN`, `NOT_AN_ADMIN`" names codes a later slice adds.
  const current = table.replace(/and later[^)]*/g, '');
  return [...current.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1] ?? '');
}

describe('[FR-ADM-05] operator error codes', () => {
  it('[FR-ADM-05] CLI_ERROR_CODES equals the codes in contracts/cli.md', () => {
    const documented = documentedCodes();
    expect(documented.length).toBeGreaterThan(0);
    expect([...CLI_ERROR_CODES].sort()).toEqual([...new Set(documented)].sort());
  });
});
