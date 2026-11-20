import { describe, expect, it } from 'vitest';
import * as locks from '../../src/db/locks.js';

// Advisory lock keys share one namespace per database: two names on one key would make
// unrelated work wait for each other, or worse, exclude each other.

describe('[NFR-CON-01] advisory lock keys', () => {
  it('[NFR-CON-01] every key is a distinct bigint', () => {
    const keys = Object.entries(locks).filter(([name]) => name.endsWith('_LOCK'));
    expect(keys.map(([name]) => name).sort()).toEqual([
      'ADMIN_LOCK',
      'APPROVAL_POLICY_LOCK',
      'PURGE_LOCK',
    ]);
    for (const [name, key] of keys) expect(typeof key, name).toBe('bigint');
    expect(new Set(keys.map(([, key]) => key)).size).toBe(keys.length);
  });
});
