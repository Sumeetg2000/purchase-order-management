import { describe, expect, it } from 'vitest';
import { oneOf } from '../src/one-of.js';

const LEVELS = ['public', 'role', 'admin'] as const;

describe('[NFR-API-01] oneOf', () => {
  it('[NFR-API-01] accepts each member of the list', () => {
    for (const level of LEVELS) expect(oneOf(LEVELS, level)).toBe(true);
  });

  it('[NFR-API-01] refuses anything else, whatever its type', () => {
    for (const value of ['PUBLIC', 'roles', '', null, undefined, 0, {}, ['role']]) {
      expect(oneOf(LEVELS, value)).toBe(false);
    }
  });

  it('[NFR-API-01] matches null when the list has it', () => {
    expect(oneOf(['A', null] as const, null)).toBe(true);
  });
});
