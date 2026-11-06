import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_ERROR_CODES } from '../../src/lib/operator-codes.js';

// The CLI and bootstrap error codes in code are exactly those the contracts list: slice 0's
// exit-code table (contracts/cli.md) and the "Refused" column of the commands slice 1 adds.
function contract(path: string): string[] {
  return readFileSync(new URL(`../../../specs/${path}`, import.meta.url), 'utf8').split('\n');
}

function codesIn(text: string): string[] {
  return [...text.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1] ?? '');
}

function documentedCodes(): string[] {
  const exitTable = contract('001-foundation/contracts/cli.md').filter((line) =>
    /^\| `\d` \|/.test(line),
  );
  // | Command | Success | Refused | No-op |: the third column names the refusal codes,
  // each followed by an explanation in parentheses, which is not a code.
  const refused = contract('002-accounts-user-management/contracts/cli.md')
    .filter((line) => /^\| `admin:/.test(line))
    .map((line) => (line.split('|')[3] ?? '').replace(/\([^)]*\)/g, ''));
  return [...exitTable, ...refused].flatMap(codesIn);
}

describe('[FR-ADM-05] operator error codes', () => {
  it('[FR-ADM-05] CLI_ERROR_CODES equals the codes in the cli contracts', () => {
    const documented = documentedCodes();
    expect(documented).toContain('LAST_ADMIN');
    expect([...CLI_ERROR_CODES].sort()).toEqual([...new Set(documented)].sort());
  });
});
