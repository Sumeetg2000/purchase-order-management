import { test as base } from '@playwright/test';
import { resetSharedLimits } from './limits';

// The base `test` of every spec: before a spec file's first test in a worker, the stack's
// per-address rate-limit counters are cleared (limits.ts), so no file inherits another's
// logins or signups. Per-email and per-user counters are left alone.

let resetFor: string | undefined;

export const test = base.extend<{ freshSharedLimits: undefined }>({
  freshSharedLimits: [
    async ({ baseURL }, provide, testInfo) => {
      const file = `${testInfo.project.name}:${testInfo.file}`;
      if (resetFor !== file) {
        resetSharedLimits(baseURL);
        resetFor = file;
      }
      await provide(undefined);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
