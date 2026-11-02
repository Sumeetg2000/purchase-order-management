import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// zod-config.ts turns Zod's eval probe off for the CSP. That only reaches the schemas in
// @po/contracts if the app and the contracts package share one Zod.
const require = createRequire(import.meta.url);
const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = fileURLToPath(new URL('../../packages/contracts', import.meta.url));

const dependencies = (dir: string) =>
  (
    JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as {
      dependencies: Record<string, string>;
    }
  ).dependencies;

describe('[NFR-FE-05] one Zod for the app and the contracts', () => {
  it('[NFR-FE-05] the app declares Zod at the contracts package version', () => {
    expect(dependencies(FRONTEND)['zod']).toBe(dependencies(CONTRACTS)['zod']);
  });

  it('[NFR-FE-05] both resolve to the same installed copy', () => {
    expect(require.resolve('zod', { paths: [FRONTEND] })).toBe(
      require.resolve('zod', { paths: [CONTRACTS] }),
    );
  });
});
