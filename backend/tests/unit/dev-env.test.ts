import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { apiDevEnv } from '../../../scripts/dev-env.mjs';
import { apiConfig } from '../../src/config/api.js';

// scripts/dev-env.mjs can't import the TypeScript config, so its list is pinned here.
const example = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));

describe('[NFR-OPS-02] dev loop API environment', () => {
  it('[NFR-OPS-02] holds exactly the variables the API reads', () => {
    expect(Object.keys(apiDevEnv(example)).sort()).toEqual([...apiConfig.keys].sort());
  });

  it('[NFR-OPS-02] passes the API config check', () => {
    expect(apiConfig.schema.safeParse(apiDevEnv(example)).success).toBe(true);
  });
});
