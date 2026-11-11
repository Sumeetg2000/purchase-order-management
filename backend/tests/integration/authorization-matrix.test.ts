import { OPERATIONS, type Access, type OperationContract } from '@po/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { accountsHarness, APP_ORIGIN, cookieHeader, type CookieJar } from '../support/accounts.js';

// The authorization matrix (ADR-0004), generated from the route table: every operation ×
// every caller kind, each cell asserted. Every request carries an unknown query field, so
// a caller the authorize step lets through stops at 400 VALIDATION_FAILED, before any
// handler runs. That proves the cell is open and changes nothing, and a refused cell
// proves the refusal comes before validation (precedence).

/** Each operation's access level, pinned here: changing a cell needs sign-off. */
const PINNED_ACCESS: Record<string, Access> = {
  getHealth: 'public',
  getReadiness: 'public',
  login: 'public',
  signup: 'public',
  verifyEmail: 'public',
  resendVerification: 'public',
  forgotPassword: 'public',
  resetPassword: 'public',
  refreshSession: 'refresh',
  logout: 'refresh',
  logoutAll: 'refresh',
  getMe: 'user',
  updateMe: 'user',
  changePassword: 'user',
  listSessions: 'user',
  revokeSession: 'user',
  getOwnAccessRequest: 'no-role',
  sendAccessRequest: 'no-role',
  listUsers: 'admin',
  getUser: 'admin',
  updateUser: 'admin',
  sendUserPasswordReset: 'admin',
  listAccessRequests: 'admin',
  dismissAccessRequest: 'admin',
  listVendors: 'role',
  getVendor: 'role',
  createVendor: 'role',
};

/** The roles of each role-level operation (ADR-0004's vendor rows), pinned the same way. */
const PINNED_ROLES: Record<string, readonly string[]> = {
  listVendors: ['BUYER', 'APPROVER', 'ADMIN'],
  getVendor: ['BUYER', 'APPROVER', 'ADMIN'],
  createVendor: ['BUYER'],
};

/** Callable with no session (ADR-0004 "Public endpoints", plus the slice 0 health checks). */
const PUBLIC_OPERATIONS = [
  'forgotPassword',
  'getHealth',
  'getReadiness',
  'login',
  'resendVerification',
  'resetPassword',
  'signup',
  'verifyEmail',
];

const CALLERS = {
  anonymous: null,
  'no role': '{}',
  Buyer: '{BUYER}',
  Approver: '{APPROVER}',
  'Buyer+Approver': '{BUYER,APPROVER}',
  Admin: '{ADMIN}',
} as const;
type Caller = keyof typeof CALLERS;

type Outcome = 'OPEN' | 'UNAUTHENTICATED' | 'NO_ROLE_ASSIGNED' | 'FORBIDDEN';

/** The cell's expected outcome, from ADR-0004's matrix. */
function expected({ access, roles }: OperationContract, caller: Caller): Outcome {
  if (access === 'public') return 'OPEN';
  if (caller === 'anonymous') return 'UNAUTHENTICATED';
  switch (access) {
    case 'refresh':
    case 'user':
      return 'OPEN';
    case 'no-role':
      return caller === 'no role' ? 'OPEN' : 'FORBIDDEN';
    case 'admin':
      if (caller === 'no role') return 'NO_ROLE_ASSIGNED';
      return caller === 'Admin' ? 'OPEN' : 'FORBIDDEN';
    case 'role': {
      if (caller === 'no role') return 'NO_ROLE_ASSIGNED';
      const held = CALLERS[caller].replace(/[{}]/g, '').split(',');
      return held.some((role) => roles?.includes(role as never)) ? 'OPEN' : 'FORBIDDEN';
    }
  }
}

const STATUS: Record<Outcome, number> = {
  OPEN: 400,
  UNAUTHENTICATED: 401,
  NO_ROLE_ASSIGNED: 403,
  FORBIDDEN: 403,
};

const ANY_ID = '00000000-0000-7000-8000-000000000000';
const operations: readonly OperationContract[] = Object.values(OPERATIONS);

describe('[NFR-AUTH-02] the route table is the pinned matrix', () => {
  it('[NFR-AUTH-02] every operation has a pinned access level, and it matches the contract', () => {
    const served = Object.fromEntries(operations.map((op) => [op.operationId, op.access]));
    expect(served).toEqual(PINNED_ACCESS);
  });

  it('[NFR-AUTH-02] every role-level operation has its pinned roles', () => {
    const served = Object.fromEntries(
      operations.filter((op) => op.roles).map((op) => [op.operationId, op.roles]),
    );
    expect(served).toEqual(PINNED_ROLES);
  });

  it('[NFR-AUTH-02] the public operations are exactly the pinned list', () => {
    const open = operations.filter((op) => op.access === 'public').map((op) => op.operationId);
    expect(open.sort()).toEqual(PUBLIC_OPERATIONS);
  });
});

describe('[SC-005] authorization matrix: every operation × every caller kind', () => {
  it('[NFR-AUTH-02] each cell is open or refused exactly as the matrix says', async () => {
    const h = await accountsHarness();
    const jars = new Map<Caller, CookieJar | null>();
    for (const [caller, roles] of Object.entries(CALLERS) as [Caller, string | null][]) {
      jars.set(caller, roles === null ? null : await h.loggedIn(await h.seedUser({ roles })));
    }

    const cells: string[] = [];
    for (const op of operations) {
      const path = `${op.path.replace(/:\w+/g, ANY_ID)}?matrixProbe=1`;
      for (const caller of Object.keys(CALLERS) as Caller[]) {
        const jar = jars.get(caller) ?? null;
        const agent = request(h.app);
        let req = agent[op.method](path).set('Origin', APP_ORIGIN);
        if (jar) {
          req = req
            .set('Cookie', cookieHeader(jar, 'po_access', 'po_refresh'))
            .set('X-CSRF-Token', jar['po_csrf'] ?? '');
        }
        const res = await req;
        const outcome = expected(op, caller);
        const cell = `${op.operationId} × ${caller}`;
        cells.push(cell);
        expect(res.status, cell).toBe(STATUS[outcome]);
        if (outcome === 'OPEN') {
          expect(res.body, cell).toMatchObject({
            code: 'VALIDATION_FAILED',
            details: expect.arrayContaining([
              { path: 'query.matrixProbe', code: 'UNKNOWN_FIELD' },
            ]) as unknown,
          });
        } else {
          expect(res.body, cell).toMatchObject({ code: outcome });
        }
      }
    }
    // Zero cells untested: 27 operations (2 health checks, 22 of slice 1, 3 vendor ones so
    // far) × 6 callers.
    expect(cells).toHaveLength(operations.length * Object.keys(CALLERS).length);
    expect(operations).toHaveLength(27);
  });
});
