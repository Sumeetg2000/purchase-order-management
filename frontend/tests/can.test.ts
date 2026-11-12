import { OPERATIONS } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { canCall, type OperationName } from '../src/auth/can';

// canCall: the screens hide what the API refuses, by OPERATIONS' access rules.

const user = (...roles: ('BUYER' | 'APPROVER' | 'ADMIN')[]) => ({ roles });

describe('[NFR-FE-08] canCall', () => {
  it('[NFR-FE-08] follows each access level', () => {
    expect(canCall('login', null)).toBe(true);
    expect(canCall('getMe', null)).toBe(false);
    expect(canCall('getMe', user())).toBe(true);
    expect(canCall('sendAccessRequest', user())).toBe(true);
    expect(canCall('sendAccessRequest', user('BUYER'))).toBe(false);
    expect(canCall('listUsers', user('ADMIN'))).toBe(true);
    expect(canCall('listUsers', user('BUYER', 'APPROVER'))).toBe(false);
  });

  it('[NFR-FE-08] a role operation is open exactly to its roles', () => {
    const roleOperations = (Object.keys(OPERATIONS) as OperationName[]).filter(
      (name) => OPERATIONS[name].access === 'role',
    );
    expect(roleOperations).toContain('createVendor');
    for (const name of roleOperations) {
      const allowed: readonly string[] = (OPERATIONS[name] as { roles: readonly string[] }).roles;
      for (const role of ['BUYER', 'APPROVER', 'ADMIN'] as const) {
        expect(canCall(name, user(role)), `${name} for ${role}`).toBe(allowed.includes(role));
      }
      expect(canCall(name, user()), `${name} with no role`).toBe(false);
    }
  });
});
