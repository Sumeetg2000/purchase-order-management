import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ACCESS_LEVELS,
  ACCESS_REQUEST_MESSAGE_MAX_LENGTH,
  ACCESS_REQUEST_NOTE_MAX_LENGTH,
  accessRequestBody,
  accessRequestListQuery,
  ASSIGNABLE_ROLE_SETS,
  changePasswordBody,
  dismissBody,
  emailBody,
  idParams,
  loginBody,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  pageQuery,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
  resetPasswordBody,
  ROLE_SETS,
  signupBody,
  tokenBody,
  updateMeBody,
  updateUserBody,
  USER_NAME_MAX_LENGTH,
  userListQuery,
} from '../src/index.js';

// The slice 1 request schemas (contracts/api.md), reviewed before any service code.

function issues(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues;
}

/** The field code a custom issue carries (research R4), or the Zod issue code. */
function codes(schema: z.ZodType, value: unknown): string[] {
  return issues(schema, value).map((issue) => {
    const params = (issue as { params?: { fieldCode?: string } }).params;
    return params?.fieldCode ?? issue.code;
  });
}

const email = 'buyer@example.local';
const password = 'correct horse battery';

describe('[NFR-VAL-01] slice 1 shared request schemas', () => {
  it('[NFR-VAL-01] the access levels are public, refresh, user, no-role and admin', () => {
    expect([...ACCESS_LEVELS]).toEqual(['public', 'refresh', 'user', 'no-role', 'admin']);
  });

  it('[NFR-VAL-01] pages default to 1 and PAGE_SIZE_DEFAULT, and page size is capped', () => {
    expect(pageQuery.parse({})).toEqual({ page: 1, pageSize: PAGE_SIZE_DEFAULT });
    expect(pageQuery.parse({ page: '3', pageSize: String(PAGE_SIZE_MAX) })).toEqual({
      page: 3,
      pageSize: PAGE_SIZE_MAX,
    });
    for (const bad of [{ page: '0' }, { pageSize: String(PAGE_SIZE_MAX + 1) }, { page: '1.5' }]) {
      expect(pageQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(pageQuery.safeParse({ sort: 'name' }).success).toBe(false);
  });

  it('[NFR-VAL-01] an id must be a UUID', () => {
    expect(idParams.safeParse({ id: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f' }).success).toBe(true);
    expect(idParams.safeParse({ id: '42' }).success).toBe(false);
  });
});

describe('[FR-ACC-04] password policy schema', () => {
  it('[FR-ACC-04] accepts 12 to 128 characters, counted as characters, not UTF-16 units', () => {
    expect(codes(passwordSchema, 'a'.repeat(PASSWORD_MIN_LENGTH))).toEqual([]);
    expect(codes(passwordSchema, 'a'.repeat(PASSWORD_MAX_LENGTH))).toEqual([]);
    // Twelve emoji are twelve characters, though 24 UTF-16 units.
    expect(codes(passwordSchema, '😀'.repeat(PASSWORD_MIN_LENGTH))).toEqual([]);
    expect(codes(passwordSchema, '😀'.repeat(PASSWORD_MAX_LENGTH))).toEqual([]);
  });

  it('[FR-ACC-04] a short or long password carries PASSWORD_TOO_SHORT or PASSWORD_TOO_LONG', () => {
    expect(codes(passwordSchema, 'a'.repeat(PASSWORD_MIN_LENGTH - 1))).toEqual([
      'PASSWORD_TOO_SHORT',
    ]);
    expect(codes(passwordSchema, '😀'.repeat(PASSWORD_MIN_LENGTH - 1))).toEqual([
      'PASSWORD_TOO_SHORT',
    ]);
    expect(codes(passwordSchema, 'a'.repeat(PASSWORD_MAX_LENGTH + 1))).toEqual([
      'PASSWORD_TOO_LONG',
    ]);
  });

  it('[FR-ACC-04] signup, reset and change-password all apply it', () => {
    const short = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);
    expect(codes(signupBody, { name: 'A', email, password: short })).toEqual([
      'PASSWORD_TOO_SHORT',
    ]);
    expect(codes(resetPasswordBody, { token: 't', newPassword: short })).toEqual([
      'PASSWORD_TOO_SHORT',
    ]);
    expect(codes(changePasswordBody, { currentPassword: 'old', newPassword: short })).toEqual([
      'PASSWORD_TOO_SHORT',
    ]);
  });

  it('[FR-ACC-04] login and change-password accept every password the policy accepts', () => {
    // Counted in characters like the policy: 128 emoji are 256 UTF-16 units.
    const longest = '😀'.repeat(PASSWORD_MAX_LENGTH);
    expect(codes(loginBody, { email, password: longest })).toEqual([]);
    expect(codes(changePasswordBody, { currentPassword: longest, newPassword: password })).toEqual(
      [],
    );
    expect(loginBody.safeParse({ email, password: `${longest}😀` }).success).toBe(false);
  });

  it('[FR-ACC-04] login checks only that a password is present and not over the maximum', () => {
    // An old password may predate a policy change (contracts/api.md).
    expect(codes(loginBody, { email, password: 'short' })).toEqual([]);
    expect(loginBody.safeParse({ email, password: '' }).success).toBe(false);
    expect(
      loginBody.safeParse({ email, password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });
});

describe('[NFR-VAL-01] slice 1 bodies are strict', () => {
  it.each([
    ['login', loginBody, { email, password, remember: true }],
    ['signup with roles', signupBody, { name: 'A', email, password, roles: ['ADMIN'] }],
    ['signup with status', signupBody, { name: 'A', email, password, status: 'ACTIVE' }],
    ['token', tokenBody, { token: 't', email }],
    ['email', emailBody, { email, name: 'A' }],
    ['profile with a phone', updateMeBody, { name: 'A', phone: '+919876543210' }],
    ['profile with an email', updateMeBody, { name: 'A', email }],
    ['access request', accessRequestBody, { message: 'm', role: 'BUYER' }],
    ['dismiss', dismissBody, { note: 'n', status: 'RESOLVED' }],
    ['admin user update', updateUserBody, { roles: ['BUYER'], name: 'B' }],
  ])('[NFR-VAL-01] %s refuses an unknown field', (_case, schema, value) => {
    expect(codes(schema, value)).toContain('unrecognized_keys');
  });

  it('[FR-USR-01] the profile edit takes a trimmed name of 1 to USER_NAME_MAX_LENGTH characters', () => {
    expect(updateMeBody.parse({ name: '  Asha  ' })).toEqual({ name: 'Asha' });
    expect(updateMeBody.safeParse({}).success).toBe(false);
    expect(updateMeBody.safeParse({ name: '   ' }).success).toBe(false);
    expect(updateMeBody.safeParse({ name: 'n'.repeat(USER_NAME_MAX_LENGTH + 1) }).success).toBe(
      false,
    );
  });

  it('[FR-ACC-09] an access request message is trimmed, 1 to ACCESS_REQUEST_MESSAGE_MAX_LENGTH characters', () => {
    expect(accessRequestBody.parse({ message: ' Please ' })).toEqual({ message: 'Please' });
    expect(accessRequestBody.safeParse({ message: ' ' }).success).toBe(false);
    expect(
      accessRequestBody.safeParse({ message: 'm'.repeat(ACCESS_REQUEST_MESSAGE_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it('[FR-ADM-06] a dismiss note is optional and at most ACCESS_REQUEST_NOTE_MAX_LENGTH characters', () => {
    expect(dismissBody.parse({})).toEqual({});
    expect(
      dismissBody.safeParse({ note: 'n'.repeat(ACCESS_REQUEST_NOTE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('[FR-ADM-02] an admin user update needs roles or isActive', () => {
    expect(updateUserBody.safeParse({}).success).toBe(false);
    expect(updateUserBody.safeParse({ isActive: false }).success).toBe(true);
    expect(updateUserBody.safeParse({ roles: ['BUYER', 'APPROVER'] }).success).toBe(true);
    expect(updateUserBody.safeParse({ roles: ['OWNER'] }).success).toBe(false);
  });

  it('[FR-ACC-07] the assignable role sets are every role set except none and Admin', () => {
    expect(ASSIGNABLE_ROLE_SETS).toEqual(
      ROLE_SETS.filter((set) => set.length > 0 && !(set as readonly string[]).includes('ADMIN')),
    );
  });
});

describe('[FR-ADM-01] list queries', () => {
  it('[FR-ADM-01] the user list filters by role (NONE for no role), status and a trimmed q', () => {
    expect(userListQuery.parse({ role: 'NONE', status: 'ACTIVE', q: ' asha ' })).toEqual({
      page: 1,
      pageSize: PAGE_SIZE_DEFAULT,
      role: 'NONE',
      status: 'ACTIVE',
      q: 'asha',
    });
    expect(userListQuery.safeParse({ role: 'OWNER' }).success).toBe(false);
    expect(userListQuery.safeParse({ q: '  ' }).success).toBe(false);
    expect(userListQuery.safeParse({ sort: 'email' }).success).toBe(false);
  });

  it('[FR-ADM-06] the access-request list filters by status', () => {
    expect(accessRequestListQuery.parse({ status: 'OPEN' })).toMatchObject({ status: 'OPEN' });
    expect(accessRequestListQuery.safeParse({ status: 'CLOSED' }).success).toBe(false);
  });
});
