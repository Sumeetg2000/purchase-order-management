import { describe, expect, it } from 'vitest';
import {
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  commonPasswordError,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../src/auth/passwords.js';

// argon2id hashing and the common-password check (ADR-0017, research R3, R4).

describe('[NFR-SEC-05] password hashing', () => {
  it('[NFR-SEC-05] hashes with argon2id at 19 MiB, 2 iterations, parallelism 1', async () => {
    expect([ARGON2_MEMORY_KIB, ARGON2_TIME_COST, ARGON2_PARALLELISM]).toEqual([19 * 1024, 2, 1]);
    const [, algorithm, version, params] = (await hashPassword('correct horse battery')).split('$');
    expect([algorithm, version]).toEqual(['argon2id', 'v=19']);
    // PHC parameters, in whatever order the library writes them.
    expect(Object.fromEntries((params ?? '').split(',').map((p) => p.split('=')))).toEqual({
      m: '19456',
      t: '2',
      p: '1',
    });
  });

  it('[NFR-SEC-05] salts every hash, and verifies only the right password', async () => {
    const [first, second] = await Promise.all([
      hashPassword('correct horse battery'),
      hashPassword('correct horse battery'),
    ]);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(first, 'Correct horse battery')).toBe(false);
  });

  it('[NFR-SEC-05] a malformed stored hash verifies nothing instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'anything at all')).toBe(false);
  });

  it('[NFR-SEC-05] a hash made with another profile needs a rehash; a current one does not', async () => {
    expect(needsRehash(await hashPassword('correct horse battery'))).toBe(false);
    expect(
      needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c29tZXNhbHRzb21lc2FsdA$6m3o5Ok0yx2Ix0oKSkDZJA'),
    ).toBe(true);
  });
});

describe('[FR-ACC-04] common-password check', () => {
  it('[FR-ACC-04] refuses a listed password, whatever its case, at the given path', () => {
    for (const password of ['password1234', 'PassWord1234', 'QWERTYUIOP123']) {
      expect(commonPasswordError('body.password', password), password).toEqual({
        path: 'body.password',
        code: 'PASSWORD_TOO_COMMON',
      });
    }
    expect(commonPasswordError('body.newPassword', 'iloveyou1234')).toEqual({
      path: 'body.newPassword',
      code: 'PASSWORD_TOO_COMMON',
    });
  });

  it('[FR-ACC-04] accepts a password that is not listed', () => {
    expect(commonPasswordError('body.password', 'correct horse battery staple')).toBeUndefined();
  });
});
