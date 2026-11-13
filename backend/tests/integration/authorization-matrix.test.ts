import {
  OPERATIONS,
  ORDER_ADMIN_READ_ONLY_MESSAGE,
  type Access,
  type OperationContract,
} from '@po/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { accountsHarness, APP_ORIGIN, cookieHeader, type CookieJar } from '../support/accounts.js';
import { ordersHarness } from '../support/orders.js';
import { vendorBody, vendorsHarness } from '../support/vendors.js';

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
  updateVendor: 'role',
  listVendorHistory: 'role',
  deactivateVendor: 'role',
  reactivateVendor: 'role',
  listOrders: 'role',
  listOrderTimeline: 'role',
  getOrder: 'role',
  createOrder: 'role',
  editOrder: 'role',
};

/** The roles of each role-level operation (ADR-0004's vendor rows), pinned the same way. */
const PINNED_ROLES: Record<string, readonly string[]> = {
  listVendors: ['BUYER', 'APPROVER', 'ADMIN'],
  getVendor: ['BUYER', 'APPROVER', 'ADMIN'],
  createVendor: ['BUYER'],
  updateVendor: ['BUYER'],
  listVendorHistory: ['BUYER', 'ADMIN'],
  deactivateVendor: ['BUYER'],
  reactivateVendor: ['BUYER'],
  listOrders: ['BUYER', 'APPROVER', 'ADMIN'],
  listOrderTimeline: ['BUYER', 'APPROVER', 'ADMIN'],
  getOrder: ['BUYER', 'APPROVER', 'ADMIN'],
  createOrder: ['BUYER'],
  editOrder: ['BUYER'],
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
          // An Admin refused an order write is told why (ADR-0004, 2026-11-12).
          if (outcome === 'FORBIDDEN' && caller === 'Admin' && op.adminForbiddenDetail) {
            expect(res.body, cell).toMatchObject({ detail: op.adminForbiddenDetail });
          } else {
            expect((res.body as { detail?: unknown }).detail, cell).toBeUndefined();
          }
        }
      }
    }
    // Zero cells untested: 36 operations (2 health checks, 22 of slice 1, 7 vendor ones,
    // 5 order ones so far) × 6 callers.
    expect(cells).toHaveLength(operations.length * Object.keys(CALLERS).length);
    expect(operations).toHaveLength(36);
  });
});

describe('[FR-ACT-01] the vendor rows (ADR-0004)', () => {
  /** Every vendor write, each with a body or headers that would fail validation. */
  const WRITES = [
    { op: 'createVendor', method: 'post', path: () => '/vendors', body: { bogus: 1 } },
    { op: 'updateVendor', method: 'put', path: (id: string) => `/vendors/${id}`, body: {} },
    {
      op: 'deactivateVendor',
      method: 'post',
      path: (id: string) => `/vendors/${id}/deactivate`,
      body: { bogus: 1 },
    },
    {
      op: 'reactivateVendor',
      method: 'post',
      path: (id: string) => `/vendors/${id}/reactivate`,
      body: { bogus: 1 },
    },
  ] as const;

  it('[FR-ACT-01] Approver and Admin writes are 403 FORBIDDEN before the body is validated, changing nothing', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    for (const roles of ['{APPROVER}', '{ADMIN}']) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      for (const write of WRITES) {
        // No If-Match either: the role refusal comes before every 400.
        const res = await h.send(write.method, write.path(id), jar, write.body);
        expect(res.status, `${write.op} as ${roles}`).toBe(403);
        expect(res.body, `${write.op} as ${roles}`).toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    expect(await h.query('SELECT version FROM vendors')).toEqual([{ version: 1 }]);
    expect(await h.vendorAudit()).toEqual([]);
  });

  it('[FR-ACT-01] a user with no role is 403 NO_ROLE_ASSIGNED and an anonymous caller 401 on vendor reads', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    const noRole = await h.loggedIn(await h.seedUser({ roles: '{}' }));
    for (const path of ['/vendors', `/vendors/${id}`]) {
      const refused = await h.get(path, noRole);
      expect(refused.status, path).toBe(403);
      expect(refused.body, path).toMatchObject({ code: 'NO_ROLE_ASSIGNED' });
      const anonymous = await request(h.app).get(path).set('Origin', APP_ORIGIN);
      expect(anonymous.status, path).toBe(401);
      expect(anonymous.body, path).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('[FR-ACT-01] vendors have no owner: another Buyer edits, deactivates and reactivates one', async () => {
    const h = await vendorsHarness();
    const created = await h.createVendor(vendorBody());
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));

    expect(
      (await h.updateVendor(id, vendorBody({ name: 'Acme Industrial' }), 1, other)).status,
    ).toBe(200);
    expect((await h.setStatus(id, 'deactivate', 2, other)).status).toBe(200);
    expect((await h.setStatus(id, 'reactivate', 3, other)).status).toBe(200);
    expect((await h.vendorAudit()).map((entry) => entry.action)).toEqual([
      'VENDOR_CREATED',
      'VENDOR_UPDATED',
      'VENDOR_DEACTIVATED',
      'VENDOR_REACTIVATED',
    ]);
  });
});

describe('[FR-OWN-01] the draft order rows (ADR-0004)', () => {
  it('[FR-OWN-01] a draft is read by its owner and an Admin; another Buyer, an Approver and a Buyer+Approver get 404', async () => {
    const h = await ordersHarness();
    const created = await h.createOrder(h.orderBody());
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const readers: [string, number][] = [
      ['{BUYER}', 404],
      ['{APPROVER}', 404],
      ['{BUYER,APPROVER}', 404],
      ['{ADMIN}', 200],
    ];
    expect((await h.getOrder(id)).status).toBe(200);
    for (const [roles, status] of readers) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.getOrder(id, jar);
      expect(res.status, roles).toBe(status);
      if (status === 404) expect(res.body, roles).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('[FR-ACT-01] an Approver or an Admin editing a draft is 403 before validation, the Admin told why', async () => {
    const h = await ordersHarness();
    const id = ((await h.createOrder(h.orderBody())).body as { id: string }).id;
    for (const [roles, detail] of [
      ['{APPROVER}', undefined],
      ['{ADMIN}', ORDER_ADMIN_READ_ONLY_MESSAGE],
    ] as const) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.editOrder(id, { bogus: 1 }, null, jar);
      expect(res.status, roles).toBe(403);
      expect(res.body, roles).toMatchObject({ code: 'FORBIDDEN' });
      expect((res.body as { detail?: string }).detail, roles).toBe(detail);
    }
    expect(((await h.getOrder(id)).body as { version: number }).version).toBe(1);
  });

  it('[FR-ACT-01] an Approver or an Admin creating an order is 403 before validation, the Admin told why', async () => {
    const h = await ordersHarness();
    for (const [roles, detail] of [
      ['{APPROVER}', undefined],
      ['{ADMIN}', ORDER_ADMIN_READ_ONLY_MESSAGE],
    ] as const) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.createOrder({ bogus: 1 }, { as: jar, key: null });
      expect(res.status, roles).toBe(403);
      expect(res.body, roles).toMatchObject({ code: 'FORBIDDEN' });
      expect((res.body as { detail?: string }).detail, roles).toBe(detail);
    }
    expect(await h.count('purchase_orders')).toBe(0);
  });
});
